import type { CallToken, SessionView } from "@astro/shared";
import { describe, expect, it, vi } from "vitest";
import {
  CallMedia,
  type LiveKitAdapter,
  type MediaElementLike,
  type RemoteTrackLike,
  type RoomLike,
  type TokenResult,
} from "../src/lib/call/media";
import {
  callReducer,
  callScreen,
  initialCallState,
  joinedMap,
  micIssue,
  shouldDisconnect,
  type CallAction,
  type CallState,
} from "../src/lib/call/state";
import { chatReducer, initialChatState } from "../src/lib/chat/reducer";

const session = (over: Partial<SessionView> = {}): SessionView => ({
  id: "s1",
  kind: "call",
  status: "accepted",
  end_reason: null,
  role: "user",
  astrologer: { id: "a2", slug: "meera-joshi", display_name: "Meera Joshi" },
  client_label: "Client 7Q",
  price_per_min_paise: 1250,
  is_free: false,
  free_minutes: null,
  queue: null,
  created_at: "2026-10-21T10:00:00Z",
  accepted_at: "2026-10-21T10:00:30Z",
  started_at: null,
  ended_at: null,
  billed_minutes: 0,
  billed_paise: 0,
  minutes_left: 9,
  can_review: false,
  safety_flag: false,
  ...over,
});

const run = (actions: CallAction[], from: CallState = initialCallState) =>
  actions.reduce(callReducer, from);

describe("call state", () => {
  it("joined map: the `call` socket event wins; before one, active means both are in", () => {
    expect(joinedMap(session(), null)).toEqual({ user: false, astrologer: false });
    expect(joinedMap(session({ status: "active" }), null)).toEqual({
      user: true,
      astrologer: true,
    });
    expect(joinedMap(session({ status: "active" }), { user: true, astrologer: false })).toEqual({
      user: true,
      astrologer: false,
    });
  });

  it("the chat reducer records who is in the audio room from `call` events", () => {
    const s = chatReducer(initialChatState, {
      type: "server",
      event: { type: "call", joined: { user: true, astrologer: false } },
      now: 0,
    });
    expect(s.callJoined).toEqual({ user: true, astrologer: false });
    const t = chatReducer(s, {
      type: "server",
      event: { type: "call", joined: { user: true, astrologer: true } },
      now: 0,
    });
    expect(t.callJoined).toEqual({ user: true, astrologer: true });
  });

  it("leaves the room when the session ends or the socket closes with 4000 / 4003", () => {
    expect(shouldDisconnect("active", "open")).toBe(false);
    expect(shouldDisconnect("accepted", "reconnecting")).toBe(false);
    // Another tab took the control socket: its audio is not ours to cut.
    expect(shouldDisconnect("active", "replaced")).toBe(false);
    for (const s of ["completed", "cancelled", "failed"] as const)
      expect(shouldDisconnect(s, "open")).toBe(true);
    expect(shouldDisconnect("active", "closed")).toBe(true);
    expect(shouldDisconnect("active", "forbidden")).toBe(true);
    expect(shouldDisconnect(null, "connecting")).toBe(false);
  });

  it("maps microphone errors to something the user can act on", () => {
    expect(micIssue({ name: "NotAllowedError" })).toBe("denied");
    expect(micIssue(new DOMException("x", "NotAllowedError"))).toBe("denied");
    expect(micIssue({ name: "NotFoundError" })).toBe("not_found");
    expect(micIssue({ name: "NotReadableError" })).toBe("in_use");
    expect(micIssue({ name: "NotSupportedError" })).toBe("unsupported");
    expect(micIssue(new Error("boom"))).toBe("other");
  });

  it("screens follow the server's status, never our guess", () => {
    const joined = { user: false, astrologer: false };
    expect(callScreen(session({ status: "requested" }), initialCallState, joined)).toBe("waiting");
    expect(callScreen(session({ status: "queued" }), initialCallState, joined)).toBe("waiting");
    // Accepted: explain the microphone first.
    expect(callScreen(session(), initialCallState, joined)).toBe("join");
    expect(callScreen(session(), run([{ type: "join_start" }]), joined)).toBe("connecting");
    const inRoom = run([
      { type: "join_start" },
      { type: "connecting" },
      { type: "connected", audioBlocked: false },
    ]);
    expect(callScreen(session(), inRoom, joined)).toBe("waiting_astrologer");
    expect(callScreen(session(), inRoom, { user: true, astrologer: true })).toBe("starting");
    // Only the server's `active` shows the call (and its timer).
    expect(
      callScreen(session({ status: "active" }), inRoom, { user: true, astrologer: true }),
    ).toBe("in_call");
    expect(callScreen(session({ status: "completed" }), inRoom, joined)).toBe("ended");
    // Reloaded mid-call: offer to rejoin.
    expect(callScreen(session({ status: "active" }), initialCallState, joined)).toBe("join");
  });

  it("microphone denied and join failures each get their own screen and a retry", () => {
    const denied = run([{ type: "join_start" }, { type: "mic_failed", issue: "denied" }]);
    expect(denied.media).toBe("idle");
    expect(callScreen(session(), denied, { user: false, astrologer: false })).toBe("mic_blocked");
    const failed = run([{ type: "join_start" }, { type: "join_failed", code: "connect_failed" }]);
    expect(callScreen(session(), failed, { user: false, astrologer: false })).toBe("join_failed");
    // Trying again clears the old error.
    expect(callReducer(denied, { type: "join_start" }).mic).toBeNull();
  });

  it("reconnecting and drops; leaving is idempotent", () => {
    const up = run([
      { type: "join_start" },
      { type: "connecting" },
      { type: "connected", audioBlocked: true },
    ]);
    expect(up.audioBlocked).toBe(true);
    expect(run([{ type: "reconnecting" }], up).media).toBe("reconnecting");
    expect(run([{ type: "reconnecting" }, { type: "reconnected" }], up).media).toBe("connected");
    expect(run([{ type: "dropped" }], up).media).toBe("dropped");
    const left = run([{ type: "left" }], up);
    expect(left.media).toBe("idle");
    expect(callReducer(left, { type: "left" })).toBe(left);
    expect(callReducer(initialCallState, { type: "dropped" })).toBe(initialCallState);
  });
});

/* ---------------------------------------------------------------- LiveKit, faked */

const EVENTS = {
  trackSubscribed: "trackSubscribed",
  trackUnsubscribed: "trackUnsubscribed",
  reconnecting: "reconnecting",
  signalReconnecting: "signalReconnecting",
  reconnected: "reconnected",
  disconnected: "disconnected",
  audioPlaybackChanged: "audioPlaybackChanged",
};

class FakeRoom implements RoomLike {
  handlers = new Map<string, ((...a: unknown[]) => void)[]>();
  connected = false;
  disconnects = 0;
  mic: boolean[] = [];
  canPlaybackAudio = true;
  connectGate: Promise<void> = Promise.resolve();
  micError: unknown = null;
  connectArgs: unknown[] = [];

  on(event: string, listener: (...args: never[]) => void) {
    const list = this.handlers.get(event) ?? [];
    list.push(listener as (...a: unknown[]) => void);
    this.handlers.set(event, list);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    for (const h of this.handlers.get(event) ?? []) h(...args);
  }
  async connect(...args: unknown[]) {
    this.connectArgs = args;
    await this.connectGate;
    this.connected = true;
  }
  async disconnect() {
    this.disconnects += 1;
    this.connected = false;
  }
  localParticipant = {
    setMicrophoneEnabled: async (on: boolean) => {
      if (this.micError) throw this.micError;
      this.mic.push(on);
    },
  };
  async startAudio() {
    this.canPlaybackAudio = true;
  }
  async switchActiveDevice() {
    return true;
  }
}

const TOKEN: CallToken = {
  url: "wss://livekit.example.test",
  token: "lk-room-token",
  room: "session-s1",
  identity: "user",
  expires_in: 600,
};

function setup(over: { preflight?: () => Promise<void>; token?: TokenResult } = {}) {
  const room = new FakeRoom();
  const actions: CallAction[] = [];
  const mounted: MediaElementLike[] = [];
  const getToken = vi.fn(async () => over.token ?? { ok: true as const, data: TOKEN });
  const createRoom = vi.fn(() => room);
  const adapter: LiveKitAdapter = {
    createRoom,
    events: EVENTS,
    preflightMic: over.preflight ?? (async () => undefined),
    supportsOutputSelection: () => false,
    listOutputs: async () => [],
  };
  const media = new CallMedia({
    load: async () => adapter,
    getToken,
    dispatch: (a) => actions.push(a),
    mountAudio: (el) => mounted.push(el),
  });
  const state = () => run(actions);
  return { room, actions, media, getToken, createRoom, mounted, state };
}

function audioTrack() {
  const el = {
    removed: false,
    remove() {
      this.removed = true;
    },
  };
  const track: RemoteTrackLike = { kind: "audio", attach: () => el, detach: () => [el] };
  return { track, el };
}

describe("joining the audio room", () => {
  it("checks the microphone, gets a token, connects with autoSubscribe and publishes the mic", async () => {
    const t = setup();
    await t.media.join();
    expect(t.getToken).toHaveBeenCalledTimes(1);
    expect(t.room.connectArgs).toEqual([TOKEN.url, TOKEN.token, { autoSubscribe: true }]);
    expect(t.room.mic).toEqual([true]);
    expect(t.state().media).toBe("connected");
    expect(t.state().audioBlocked).toBe(false);
  });

  it("plays the astrologer's audio and removes it when the track goes", async () => {
    const t = setup();
    await t.media.join();
    const { track, el } = audioTrack();
    t.room.emit("trackSubscribed", track);
    expect(t.mounted).toEqual([el]);
    t.room.emit("trackUnsubscribed", track);
    expect(el.removed).toBe(true);
    // Video (never granted anyway) is ignored.
    t.room.emit("trackSubscribed", {
      kind: "video",
      attach: () => {
        throw new Error("no");
      },
      detach: () => [],
    });
    expect(t.mounted).toHaveLength(1);
  });

  it("autoplay blocked: says so, and startAudio() (from a tap) clears it", async () => {
    const t = setup();
    t.room.canPlaybackAudio = false;
    await t.media.join();
    expect(t.state().audioBlocked).toBe(true);
    await t.media.startAudio();
    expect(t.state().audioBlocked).toBe(false);
  });

  it("microphone denied: never asks for a token and never enters the room", async () => {
    const t = setup({
      preflight: async () => {
        throw new DOMException("denied", "NotAllowedError");
      },
    });
    await t.media.join();
    expect(t.getToken).not.toHaveBeenCalled();
    expect(t.createRoom).not.toHaveBeenCalled();
    expect(t.state().mic).toBe("denied");
    expect(t.state().media).toBe("idle");
  });

  it("microphone fails after connecting: leaves the room at once", async () => {
    const t = setup();
    t.room.micError = { name: "NotReadableError" };
    await t.media.join();
    expect(t.room.disconnects).toBe(1);
    expect(t.state().mic).toBe("in_use");
    expect(t.media.inRoom).toBe(false);
  });

  it("a refused token is shown, not retried behind the user's back", async () => {
    const t = setup({ token: { ok: false, code: "session_not_joinable" } });
    await t.media.join();
    expect(t.createRoom).not.toHaveBeenCalled();
    expect(t.state().joinError).toBe("session_not_joinable");
  });

  it("leaving while still connecting disconnects and never reports connected", async () => {
    const t = setup();
    let open!: () => void;
    t.room.connectGate = new Promise((r) => (open = r));
    const joining = t.media.join();
    await vi.waitFor(() => expect(t.createRoom).toHaveBeenCalled());
    t.media.leave();
    open();
    await joining;
    expect(t.room.disconnects).toBe(1);
    expect(t.room.mic).toEqual([]);
    expect(t.actions.some((a) => a.type === "connected")).toBe(false);
    expect(t.state().media).toBe("idle");
  });

  it("ended: leave() disconnects the room and removes the audio immediately", async () => {
    const t = setup();
    await t.media.join();
    const { track, el } = audioTrack();
    t.room.emit("trackSubscribed", track);
    // What useCallMedia does on an `ended` frame or shouldDisconnect().
    t.media.leave();
    expect(t.room.disconnects).toBe(1);
    expect(el.removed).toBe(true);
    expect(t.state().media).toBe("idle");
    // The room's own `disconnected` event after that is ours, not a drop.
    t.room.emit("disconnected");
    expect(t.state().media).toBe("idle");
  });

  it("an unexpected disconnect (network gave up, room deleted) is a drop the user can rejoin", async () => {
    const t = setup();
    await t.media.join();
    t.room.emit("reconnecting");
    expect(t.state().media).toBe("reconnecting");
    t.room.emit("reconnected");
    expect(t.state().media).toBe("connected");
    t.room.emit("disconnected");
    expect(t.state().media).toBe("dropped");
    expect(t.media.inRoom).toBe(false);
  });

  it("mute toggles the published microphone", async () => {
    const t = setup();
    await t.media.join();
    await t.media.setMuted(true);
    expect(t.room.mic).toEqual([true, false]);
    expect(t.state().muted).toBe(true);
    await t.media.setMuted(false);
    expect(t.state().muted).toBe(false);
  });
});
