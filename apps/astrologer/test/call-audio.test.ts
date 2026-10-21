import type { CallToken } from "@astro/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CallAudio,
  CallTokenError,
  type AudioRoom,
  type AudioRoomEvents,
} from "../src/lib/call/audio";
import {
  callAudioReducer,
  initialCallAudio,
  type CallAudioAction,
  type CallAudioState,
} from "../src/lib/call/state";

const TOKEN: CallToken = {
  url: "wss://lk.example",
  token: "jwt",
  room: "session-s_1",
  identity: "astrologer",
  expires_in: 600,
};

class FakeRoom implements AudioRoom {
  calls: string[] = [];
  canPlay = true;
  connectError: Error | null = null;
  micError: Error | null = null;
  constructor(public events: AudioRoomEvents) {}
  async connect(url: string, token: string) {
    this.calls.push(`connect ${url} ${token}`);
    if (this.connectError) throw this.connectError;
  }
  async setMicrophone(on: boolean) {
    this.calls.push(`mic ${on}`);
    if (this.micError) throw this.micError;
  }
  async startAudio() {
    this.calls.push("startAudio");
    this.canPlay = true;
  }
  canPlayAudio() {
    return this.canPlay;
  }
  async disconnect() {
    this.calls.push("disconnect");
  }
}

function harness(
  opts: {
    mic?: () => Promise<void>;
    token?: () => Promise<CallToken>;
    room?: (r: FakeRoom) => void;
  } = {},
) {
  let state: CallAudioState = initialCallAudio;
  const actions: CallAudioAction[] = [];
  const rooms: FakeRoom[] = [];
  const getToken = vi.fn(opts.token ?? (async () => TOKEN));
  const requestMic = vi.fn(opts.mic ?? (async () => undefined));
  const audio = new CallAudio({
    getToken,
    requestMic,
    createRoom: async (events) => {
      const r = new FakeRoom(events);
      opts.room?.(r);
      rooms.push(r);
      return r;
    },
    dispatch: (a) => {
      actions.push(a);
      state = callAudioReducer(state, a);
    },
    random: () => 1,
    maxAttempts: 2,
  });
  return {
    audio,
    rooms,
    actions,
    getToken,
    requestMic,
    get state() {
      return state;
    },
    last: () => rooms[rooms.length - 1]!,
  };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const domError = (name: string) => Object.assign(new Error(name), { name });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("joining a call", () => {
  it("checks the mic first, then fetches a token, joins and turns the mic on", async () => {
    const h = harness();
    h.audio.join();
    await flush();
    expect(h.requestMic).toHaveBeenCalledTimes(1);
    expect(h.getToken).toHaveBeenCalledTimes(1);
    expect(h.last().calls).toEqual(["connect wss://lk.example jwt", "mic true"]);
    expect(h.actions.map((a) => a.type)).toEqual([
      "mic_check",
      "connecting",
      "connected",
      "mic",
      "playback",
    ]);
    expect(h.state).toMatchObject({ status: "connected", mic: "on", playbackBlocked: false });
  });

  it("is idempotent while joining or joined", async () => {
    const h = harness();
    h.audio.join();
    h.audio.join();
    await flush();
    h.audio.join();
    await flush();
    expect(h.rooms).toHaveLength(1);
    expect(h.getToken).toHaveBeenCalledTimes(1);
  });

  it("never joins the room when the microphone is denied", async () => {
    const h = harness({ mic: async () => Promise.reject(domError("NotAllowedError")) });
    h.audio.join();
    await flush();
    expect(h.getToken).not.toHaveBeenCalled();
    expect(h.rooms).toHaveLength(0);
    expect(h.state).toMatchObject({ status: "failed", failure: "mic", mic: "denied" });
  });

  it("leaves the room again if publishing the mic fails after joining", async () => {
    const h = harness({ room: (r) => (r.micError = domError("NotReadableError")) });
    h.audio.join();
    await flush();
    expect(h.last().calls).toEqual(["connect wss://lk.example jwt", "mic true", "disconnect"]);
    expect(h.state).toMatchObject({ status: "failed", failure: "mic", mic: "in_use" });
  });

  it("stops on a definite token refusal without retrying", async () => {
    const h = harness({
      token: async () => Promise.reject(new CallTokenError(409, "session_not_joinable")),
    });
    h.audio.join();
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.getToken).toHaveBeenCalledTimes(1);
    expect(h.state).toMatchObject({ status: "failed", failure: "not_joinable" });
  });

  it("retries a 5xx token error with backoff, then gives up with 'Try again'", async () => {
    const h = harness({ token: async () => Promise.reject(new CallTokenError(503)) });
    h.audio.join();
    await flush();
    expect(h.state.status).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.getToken).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.getToken).toHaveBeenCalledTimes(3);
    expect(h.state).toMatchObject({ status: "failed", failure: "connect_failed" });
    // Manual retry starts over.
    h.audio.retry();
    await flush();
    expect(h.getToken).toHaveBeenCalledTimes(4);
  });

  it("reports an autoplay block and clears it from a click", async () => {
    const h = harness({ room: (r) => (r.canPlay = false) });
    h.audio.join();
    await flush();
    expect(h.state.playbackBlocked).toBe(true);
    await h.audio.enableAudio();
    expect(h.last().calls).toContain("startAudio");
    expect(h.state.playbackBlocked).toBe(false);
  });
});

describe("in the call", () => {
  it("mutes and unmutes the microphone, and keeps the choice across a rejoin", async () => {
    const h = harness();
    h.audio.join();
    await flush();
    await h.audio.setMuted(true);
    expect(h.state.mic).toBe("muted");
    expect(h.audio.isMuted).toBe(true);
    h.last().events.onDisconnected("other");
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.rooms).toHaveLength(2);
    expect(h.last().calls).toEqual(["connect wss://lk.example jwt", "mic false"]);
    expect(h.state.mic).toBe("muted");
    await h.audio.setMuted(false);
    expect(h.state.mic).toBe("on");
  });

  it("rejoins with a fresh token after an unexpected drop", async () => {
    const h = harness();
    h.audio.join();
    await flush();
    h.last().events.onDisconnected("other");
    expect(h.state.status).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.getToken).toHaveBeenCalledTimes(2);
    expect(h.state.status).toBe("connected");
  });

  it("does not fight another tab that joined with the same identity", async () => {
    const h = harness();
    h.audio.join();
    await flush();
    h.last().events.onDisconnected("duplicate");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.rooms).toHaveLength(1);
    expect(h.state).toMatchObject({ status: "failed", failure: "duplicate" });
  });

  it("treats the server deleting the room as the end of the audio", async () => {
    const h = harness();
    h.audio.join();
    await flush();
    h.last().events.onDisconnected("room_closed");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.rooms).toHaveLength(1);
    expect(h.state.status).toBe("left");
  });

  it("leave() disconnects, stops retries and ignores late events", async () => {
    const h = harness();
    h.audio.join();
    await flush();
    const room = h.last();
    h.audio.leave();
    await flush();
    expect(room.calls.at(-1)).toBe("disconnect");
    expect(h.state.status).toBe("left");
    room.events.onDisconnected("other");
    room.events.onRemoteAudio(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.rooms).toHaveLength(1);
    expect(h.state).toMatchObject({ status: "left", remoteAudio: 0 });
  });

  it("leave() during the join drops the half-made room", async () => {
    let release: () => void = () => undefined;
    const h = harness({
      token: () => new Promise<CallToken>((resolve) => (release = () => resolve(TOKEN))),
    });
    h.audio.join();
    await flush();
    h.audio.leave();
    release();
    await flush();
    expect(h.rooms).toHaveLength(0);
    expect(h.state.status).toBe("left");
  });
});
