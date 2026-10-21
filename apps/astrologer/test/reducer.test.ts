import { describe, expect, it } from "vitest";
import {
  canSend,
  chatReducer,
  initialChatState,
  isPeerTyping,
  lastSeq,
  mergeMessages,
  type ChatState,
} from "../src/lib/chat/reducer";
import { msg, session } from "./fixtures";

const start = (): ChatState => ({
  ...initialChatState("astrologer", session()),
  connection: "open",
});

describe("mergeMessages", () => {
  it("orders by seq and drops duplicates", () => {
    const merged = mergeMessages([msg(1), msg(3)], [msg(2), msg(3, { text: "dup" }), msg(1)]);
    expect(merged.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(merged[2]!.text).toBe("message 3");
  });

  it("returns the same array when nothing is new", () => {
    const a = [msg(1)];
    expect(mergeMessages(a, [msg(1)])).toBe(a);
  });
});

describe("chat reducer", () => {
  it("applies live messages and backfill in seq order with no duplicates", () => {
    let s = start();
    s = chatReducer(s, { type: "server", event: { type: "message", message: msg(3) }, now: 0 });
    s = chatReducer(s, { type: "backfill", messages: [msg(1), msg(2), msg(3)] });
    s = chatReducer(s, { type: "server", event: { type: "message", message: msg(2) }, now: 0 });
    expect(s.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(lastSeq(s)).toBe(3);
  });

  it("matches the echo of an own message by client_id and drops the pending copy", () => {
    let s = chatReducer(start(), { type: "send", client_id: "c1", text: "  Namaste  " });
    expect(s.pending).toEqual([{ client_id: "c1", text: "Namaste", status: "sending" }]);
    // Sending the same client_id twice (double click) keeps one pending copy.
    expect(chatReducer(s, { type: "send", client_id: "c1", text: "Namaste" }).pending).toHaveLength(
      1,
    );
    const echo = msg(4, { sender: "astrologer", client_id: "c1", text: "Namaste" });
    s = chatReducer(s, { type: "server", event: { type: "message", message: echo }, now: 0 });
    expect(s.pending).toEqual([]);
    expect(s.messages).toEqual([echo]);
    // A resent client_id comes back as the stored message (same seq): still one copy.
    s = chatReducer(s, { type: "server", event: { type: "message", message: echo }, now: 0 });
    expect(s.messages).toHaveLength(1);
  });

  it("ignores empty sends", () => {
    const s = start();
    expect(chatReducer(s, { type: "send", client_id: "c", text: "   " })).toBe(s);
  });

  it("does not match the client's message to own pending by client_id", () => {
    let s = chatReducer(start(), { type: "send", client_id: "c1", text: "hi" });
    const theirs = msg(1, { sender: "user", client_id: "c1" });
    s = chatReducer(s, { type: "server", event: { type: "message", message: theirs }, now: 0 });
    expect(s.pending).toHaveLength(1);
  });

  it("ended: stores the final session, fails unsent messages, blocks sending", () => {
    let s = chatReducer(start(), { type: "send", client_id: "c1", text: "late" });
    const ended = session({ status: "completed", end_reason: "user_ended", billed_minutes: 3 });
    s = chatReducer(s, { type: "server", event: { type: "ended", session: ended }, now: 0 });
    expect(s.session).toEqual(ended);
    expect(s.pending[0]!.status).toBe("failed");
    expect(canSend(s)).toBe(false);
  });

  it("never moves a finished session back to open on a late state frame", () => {
    const ended = session({ status: "completed" });
    let s = chatReducer(start(), {
      type: "server",
      event: { type: "ended", session: ended },
      now: 0,
    });
    s = chatReducer(s, { type: "server", event: { type: "state", session: session() }, now: 0 });
    expect(s.session!.status).toBe("completed");
  });

  it("hello sets the server clock offset and role", () => {
    const s = chatReducer(initialChatState("astrologer"), {
      type: "server",
      event: {
        type: "hello",
        role: "astrologer",
        session: session(),
        server_time: "2026-10-21T10:00:05Z",
      },
      now: Date.parse("2026-10-21T10:00:00Z"),
    });
    expect(s.serverOffsetMs).toBe(5000);
    expect(s.session!.id).toBe("s_1");
  });

  it("shows the peer typing for a few seconds, never own typing, and clears on their message", () => {
    let s = start();
    s = chatReducer(s, { type: "server", event: { type: "typing", sender: "astrologer" }, now: 0 });
    expect(isPeerTyping(s, 1)).toBe(false);
    s = chatReducer(s, { type: "server", event: { type: "typing", sender: "user" }, now: 1000 });
    expect(isPeerTyping(s, 2000)).toBe(true);
    expect(isPeerTyping(s, 7000)).toBe(false);
    s = chatReducer(s, { type: "server", event: { type: "message", message: msg(1) }, now: 2000 });
    expect(isPeerTyping(s, 2500)).toBe(false);
  });

  it("refused sends become failed and can be retried", () => {
    let s = chatReducer(start(), { type: "send", client_id: "c1", text: "hi" });
    s = chatReducer(s, {
      type: "server",
      event: { type: "error", code: "rate_limited", message: "slow down" },
      now: 0,
    });
    expect(s.pending[0]!.status).toBe("failed");
    expect(s.error?.code).toBe("rate_limited");
    s = chatReducer(s, { type: "retry", client_id: "c1" });
    expect(s.pending[0]!.status).toBe("sending");
    s = chatReducer(s, { type: "dismiss_error" });
    expect(s.error).toBeNull();
  });

  it("can send only while active and connected", () => {
    expect(canSend(start())).toBe(true);
    expect(canSend({ ...start(), connection: "reconnecting" })).toBe(false);
    expect(canSend({ ...start(), session: session({ status: "accepted" }) })).toBe(false);
  });
});
