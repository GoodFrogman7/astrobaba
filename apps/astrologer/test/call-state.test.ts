import { describe, expect, it } from "vitest";
import {
  callAudioReducer,
  callPhaseText,
  initialCallAudio,
  joinedText,
  micFailure,
  tokenFailure,
  wantsAudio,
  type CallAudioAction,
  type CallAudioState,
} from "../src/lib/call/state";
import { chatReducer, initialChatState } from "../src/lib/chat/reducer";
import { session } from "./fixtures";

const run = (actions: CallAudioAction[], from: CallAudioState = initialCallAudio) =>
  actions.reduce(callAudioReducer, from);

describe("call audio reducer", () => {
  it("walks mic check → connecting → connected with the mic on", () => {
    const s = run([
      { type: "mic_check" },
      { type: "connecting" },
      { type: "connected" },
      { type: "mic", mic: "on" },
      { type: "playback", canPlay: true },
      { type: "remote_audio", count: 1 },
    ]);
    expect(s).toEqual({
      status: "connected",
      mic: "on",
      playbackBlocked: false,
      remoteAudio: 1,
      failure: null,
    });
  });

  it("records an autoplay block until playback is allowed", () => {
    const s = run([{ type: "connected" }, { type: "playback", canPlay: false }]);
    expect(s.playbackBlocked).toBe(true);
    expect(callAudioReducer(s, { type: "playback", canPlay: true }).playbackBlocked).toBe(false);
  });

  it("a failure clears remote audio and keeps the mic problem", () => {
    const s = run([
      { type: "connected" },
      { type: "remote_audio", count: 1 },
      { type: "failed", failure: "mic", mic: "denied" },
    ]);
    expect(s).toMatchObject({ status: "failed", failure: "mic", mic: "denied", remoteAudio: 0 });
    // A new attempt clears the failure.
    expect(callAudioReducer(s, { type: "mic_check" }).failure).toBeNull();
  });

  it("leaving drops remote audio", () => {
    const s = run([{ type: "connected" }, { type: "remote_audio", count: 2 }, { type: "left" }]);
    expect(s).toMatchObject({ status: "left", remoteAudio: 0 });
  });
});

describe("microphone errors", () => {
  it("classifies DOMException names", () => {
    const e = (name: string) => Object.assign(new Error("x"), { name });
    expect(micFailure(e("NotAllowedError"))).toBe("denied");
    expect(micFailure(e("SecurityError"))).toBe("denied");
    expect(micFailure(e("NotFoundError"))).toBe("not_found");
    expect(micFailure(e("NotReadableError"))).toBe("in_use");
    expect(micFailure(e("Whatever"))).toBe("error");
    expect(micFailure("nope")).toBe("error");
    expect(micFailure(null)).toBe("error");
  });
});

describe("when to be in the audio room", () => {
  it("only while accepted/active and this tab owns the socket", () => {
    expect(wantsAudio("accepted", null)).toBe(true);
    expect(wantsAudio("active", null)).toBe(true);
    expect(wantsAudio("requested", null)).toBe(false);
    expect(wantsAudio("completed", null)).toBe(false);
    expect(wantsAudio("active", "replaced")).toBe(false);
    expect(wantsAudio("active", "ended")).toBe(false);
    expect(wantsAudio("active", "forbidden")).toBe(false);
  });

  it("maps call-token refusals; server errors are retried", () => {
    expect(tokenFailure(401)).toBe("signed_out");
    expect(tokenFailure(409, "session_not_joinable")).toBe("not_joinable");
    expect(tokenFailure(409, "call_unavailable")).toBe("unavailable");
    expect(tokenFailure(404)).toBe("not_joinable");
    expect(tokenFailure(503, "api_unavailable")).toBeNull();
    expect(tokenFailure(502)).toBeNull();
  });
});

describe("who has joined (socket `call` event)", () => {
  it("is tracked by the chat reducer and reset when the call ends", () => {
    let s = initialChatState("astrologer", session({ kind: "call", status: "accepted" }));
    expect(s.callJoined).toBeNull();
    s = chatReducer(s, {
      type: "server",
      event: { type: "call", joined: { user: true, astrologer: false } },
      now: 0,
    });
    expect(s.callJoined).toEqual({ user: true, astrologer: false });
    s = chatReducer(s, {
      type: "server",
      event: { type: "ended", session: session({ kind: "call", status: "completed" }) },
      now: 0,
    });
    expect(s.callJoined).toEqual({ user: false, astrologer: false });
  });

  it("describes both sides by role and client label only", () => {
    expect(joinedText(null, "Client 7Q")).toEqual({
      you: "Not confirmed yet",
      client: "Not joined yet",
    });
    expect(joinedText({ user: true, astrologer: true }, "Client 7Q")).toEqual({
      you: "In the call",
      client: "Client 7Q is in the call",
    });
    expect(joinedText({ user: false, astrologer: true }, "Client 7Q").client).toBe(
      "Client 7Q has not joined",
    );
  });

  it("explains the phase of the call", () => {
    expect(callPhaseText("accepted", "connected", { user: false, astrologer: true })).toMatch(
      /Waiting for the client/,
    );
    expect(callPhaseText("accepted", "connected", { user: true, astrologer: true })).toMatch(
      /client is here/,
    );
    expect(callPhaseText("active", "connected", null)).toBe("Call in progress");
    expect(callPhaseText("active", "reconnecting", null)).toMatch(/Reconnecting/);
    expect(callPhaseText("active", "mic_check", null)).toMatch(/microphone/);
    expect(callPhaseText("completed", "connected", null)).toBe("Call ended");
  });
});
