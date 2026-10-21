import type { ChatMessage, SessionView } from "@astro/shared";
import { describe, expect, it } from "vitest";
import {
  chatReducer,
  cleanMessage,
  elapsedSeconds,
  initialChatState,
  mergeSession,
  TYPING_SHOW_MS,
  typingVisible,
  type ChatAction,
  type ChatState,
} from "../src/lib/chat/reducer";

const session = (over: Partial<SessionView> = {}): SessionView => ({
  id: "s1",
  kind: "chat",
  status: "active",
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
  started_at: "2026-10-21T10:01:00Z",
  ended_at: null,
  billed_minutes: 1,
  billed_paise: 1250,
  minutes_left: 9,
  can_review: false,
  ...over,
});

const msg = (seq: number, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `m${seq}`,
  seq,
  sender: "astrologer",
  text: `message ${seq}`,
  sent_at: "2026-10-21T10:02:00Z",
  client_id: null,
  ...over,
});

const run = (actions: ChatAction[], from: ChatState = initialChatState) =>
  actions.reduce(chatReducer, from);
const server = (event: Extract<ChatAction, { type: "server" }>["event"], now = 0): ChatAction => ({
  type: "server",
  event,
  now,
});
const withSession = run([{ type: "session", session: session() }]);

describe("chat reducer", () => {
  it("orders by seq and drops duplicates from the socket and the backfill", () => {
    const s = run(
      [
        server({ type: "message", message: msg(3) }),
        server({ type: "message", message: msg(1) }),
        { type: "backfill", messages: [msg(1), msg(2), msg(3)] },
        server({ type: "message", message: msg(2) }),
      ],
      withSession,
    );
    expect(s.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(s.lastSeq).toBe(3);
  });

  it("an optimistic message is replaced by the server's copy with the same client_id", () => {
    let s = run([{ type: "send", client_id: "c1", text: "Namaste", now: 1 }], withSession);
    expect(s.pending).toEqual([
      { client_id: "c1", text: "Namaste", status: "sending", created_at: 1 },
    ]);
    // A double submit of the same client_id is ignored.
    s = chatReducer(s, { type: "send", client_id: "c1", text: "Namaste", now: 2 });
    expect(s.pending).toHaveLength(1);
    s = run(
      [
        server({
          type: "message",
          message: msg(5, { sender: "user", text: "Namaste", client_id: "c1" }),
        }),
      ],
      s,
    );
    expect(s.pending).toEqual([]);
    expect(s.messages.map((m) => m.client_id)).toEqual(["c1"]);
    // Our own message is not announced to screen readers; the astrologer's is.
    expect(s.announce).toBeNull();
    s = run([server({ type: "message", message: msg(6) })], s);
    expect(s.announce?.seq).toBe(6);
  });

  it("a backfilled echo also clears the optimistic copy (reconnect case)", () => {
    const s = run(
      [
        { type: "send", client_id: "c9", text: "Are you there?", now: 1 },
        { type: "backfill", messages: [msg(7, { sender: "user", client_id: "c9" })] },
      ],
      withSession,
    );
    expect(s.pending).toEqual([]);
  });

  it("rate limiting fails the newest message still sending; retry resets it", () => {
    let s = run(
      [
        { type: "send", client_id: "a", text: "one", now: 1 },
        { type: "send", client_id: "b", text: "two", now: 2 },
        server({ type: "error", code: "rate_limited", message: "slow down" }),
      ],
      withSession,
    );
    expect(s.pending.map((p) => [p.client_id, p.status])).toEqual([
      ["a", "sending"],
      ["b", "failed"],
    ]);
    expect(s.lastError).toBe("rate_limited");
    s = chatReducer(s, { type: "retry", client_id: "b" });
    expect(s.pending[1]!.status).toBe("sending");
    expect(s.lastError).toBeNull();
  });

  it("ended is final: takes the server's summary and marks unsent messages as not sent", () => {
    const ended = session({
      status: "completed",
      end_reason: "insufficient_funds",
      ended_at: "2026-10-21T10:11:00Z",
      billed_minutes: 10,
      billed_paise: 12500,
      can_review: true,
    });
    const s = run(
      [
        { type: "send", client_id: "z", text: "last words", now: 1 },
        server({ type: "typing", sender: "astrologer" }, 1000),
        server({ type: "ended", session: ended }),
        // A late poll answer with the old state must not reopen the chat.
        { type: "session", session: session() },
        server({ type: "state", session: session({ status: "accepted" }) }),
      ],
      withSession,
    );
    expect(s.session).toEqual(ended);
    expect(s.pending[0]!.status).toBe("failed");
    expect(s.typingUntil).toBe(0);
  });

  it("sessions only move forward", () => {
    const active = session();
    expect(mergeSession(active, session({ status: "requested" }))).toBe(active);
    const queued = session({ status: "queued", queue: { position: 2, eta_minutes: null } });
    const next = session({ status: "queued", queue: { position: 1, eta_minutes: 8 } });
    expect(mergeSession(queued, next)).toBe(next);
    const done = session({ status: "cancelled", end_reason: "user_cancelled" });
    expect(mergeSession(done, session({ status: "failed" }))).toBe(done);
    expect(mergeSession(null, active)).toBe(active);
  });

  it("typing shows for a few seconds, only for the other side", () => {
    let s = run([server({ type: "typing", sender: "user" }, 1000)], withSession);
    expect(typingVisible(s, 1001)).toBe(false);
    s = run([server({ type: "typing", sender: "astrologer" }, 1000)], s);
    expect(typingVisible(s, 1000 + TYPING_SHOW_MS - 1)).toBe(true);
    expect(typingVisible(s, 1000 + TYPING_SHOW_MS)).toBe(false);
    // A message from them clears it.
    s = run([server({ type: "message", message: msg(1) }, 1200)], s);
    expect(typingVisible(s, 1300)).toBe(false);
  });

  it("low balance updates minutes left; hello sets the server clock offset", () => {
    let s = run([server({ type: "low_balance", minutes_left: 1 })], withSession);
    expect(s.lowBalanceMinutes).toBe(1);
    expect(s.session?.minutes_left).toBe(1);
    s = run(
      [
        server(
          { type: "hello", role: "user", session: session(), server_time: "2026-10-21T10:05:00Z" },
          Date.parse("2026-10-21T10:04:58Z"),
        ),
      ],
      s,
    );
    expect(s.serverOffsetMs).toBe(2000);
    expect(chatReducer(s, server({ type: "pong" }))).toBe(s);
  });
});

describe("chat helpers", () => {
  it("elapsed time uses the server clock and stops at ended_at", () => {
    const start = Date.parse("2026-10-21T10:01:00Z");
    expect(elapsedSeconds(session(), start + 61_000, 0)).toBe(61);
    expect(elapsedSeconds(session(), start + 60_000, 2000)).toBe(62);
    expect(elapsedSeconds(session({ ended_at: "2026-10-21T10:11:00Z" }), 0, 0)).toBe(600);
    expect(elapsedSeconds(session({ started_at: null }), start, 0)).toBe(0);
  });

  it("messages are trimmed and must be 1–2000 characters", () => {
    expect(cleanMessage("  hi  ", 2000)).toBe("hi");
    expect(cleanMessage("   ", 2000)).toBeNull();
    expect(cleanMessage("x".repeat(2001), 2000)).toBeNull();
  });
});
