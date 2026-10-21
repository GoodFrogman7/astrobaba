import { WS_CLOSE, type ChatMessage } from "@astro/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chatReducer,
  initialChatState,
  type ChatAction,
  type ChatState,
} from "../src/lib/chat/reducer";
import {
  backoffMs,
  BACKFILL_PAGE,
  ChatConnection,
  loadAll,
  OPEN,
  STALE_AFTER_MS,
  TicketError,
  type SocketLike,
} from "../src/lib/chat/socket";
import { msg, session } from "./fixtures";

class MockSocket implements SocketLike {
  readyState = 0;
  sent: unknown[] = [];
  closedWith: number | undefined;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  constructor(public url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.closedWith = code;
    this.readyState = 3;
  }
  // test helpers
  open() {
    this.readyState = OPEN;
    this.onopen?.({});
  }
  frame(ev: unknown) {
    this.onmessage?.({ data: JSON.stringify(ev) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function harness(opts: { serverMessages?: ChatMessage[]; ticketFails?: number[] } = {}) {
  let state: ChatState = initialChatState("astrologer", session());
  const sockets: MockSocket[] = [];
  const store = [...(opts.serverMessages ?? [])];
  const ticketFails = [...(opts.ticketFails ?? [])];
  let tickets = 0;
  const fetchMessages = vi.fn(async (after: number, limit: number) =>
    store.filter((m) => m.seq > after).slice(0, limit),
  );
  const dispatch = (a: ChatAction) => {
    state = chatReducer(state, a);
  };
  const conn = new ChatConnection({
    getSocketUrl: async () => {
      const fail = ticketFails.shift();
      if (fail) throw new TicketError(fail);
      tickets += 1;
      return `ws://api.test/v1/sessions/s_1/ws?ticket=t${tickets}`;
    },
    fetchMessages,
    createSocket: (url) => {
      const s = new MockSocket(url);
      sockets.push(s);
      return s;
    },
    dispatch,
    getState: () => state,
    now: () => Date.now(),
    random: () => 1,
  });
  return {
    conn,
    sockets,
    store,
    fetchMessages,
    dispatch,
    get state() {
      return state;
    },
    last: () => sockets[sockets.length - 1]!,
  };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-21T10:05:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("backoff", () => {
  it("doubles up to 30 s, with jitter in [50%, 100%]", () => {
    expect([0, 1, 2, 3, 10].map((a) => backoffMs(a, () => 1))).toEqual([
      1000, 2000, 4000, 8000, 30000,
    ]);
    expect(backoffMs(2, () => 0)).toBe(2000);
  });
});

describe("chat connection", () => {
  it("connects with a ticket, backfills from seq 0 and applies live frames", async () => {
    const h = harness({ serverMessages: [msg(1), msg(2)] });
    h.conn.start();
    await flush();
    expect(h.state.connection).toBe("connecting");
    expect(h.last().url).toContain("ticket=t1");
    h.last().open();
    await flush();
    expect(h.state.connection).toBe("open");
    expect(h.fetchMessages).toHaveBeenCalledWith(0, BACKFILL_PAGE);
    h.last().frame({ type: "message", message: msg(3) });
    h.last().frame({ type: "message", message: msg(2) });
    expect(h.state.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    h.conn.stop();
  });

  it("pings every 20 s while open", async () => {
    const h = harness();
    h.conn.start();
    await flush();
    h.last().open();
    await flush();
    h.last().frame({ type: "pong" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.last().sent).toContainEqual({ type: "ping" });
    h.conn.stop();
  });

  it("reconnects with backoff and a new ticket, then backfills only what was missed", async () => {
    const h = harness({ serverMessages: [msg(1), msg(2)] });
    h.conn.start();
    await flush();
    h.last().open();
    await flush();
    expect(h.state.messages).toHaveLength(2);

    h.last().drop(1006);
    expect(h.state.connection).toBe("reconnecting");
    h.store.push(msg(3), msg(4)); // sent while we were away
    await vi.advanceTimersByTimeAsync(999);
    expect(h.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(2);
    expect(h.last().url).toContain("ticket=t2");
    h.last().open();
    await flush();
    expect(h.fetchMessages).toHaveBeenLastCalledWith(2, BACKFILL_PAGE);
    expect(h.state.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
    h.conn.stop();
  });

  it("backs off further on repeated failures and resets after a good connection", async () => {
    const h = harness({ ticketFails: [503, 503] });
    h.conn.start();
    await flush(); // fail 1 → wait 1 s
    await vi.advanceTimersByTimeAsync(1000); // fail 2 → wait 2 s
    expect(h.sockets).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.sockets).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(1);
    h.last().open();
    await flush();
    h.last().drop();
    await vi.advanceTimersByTimeAsync(1000); // back to the first step
    expect(h.sockets).toHaveLength(2);
    h.conn.stop();
  });

  it("resends unconfirmed own messages with the same client_id after reconnecting", async () => {
    const h = harness();
    h.conn.start();
    await flush();
    h.last().open();
    await flush();
    h.last().drop();
    // Typed while offline: kept as pending, not sent.
    h.dispatch({ type: "send", client_id: "c1", text: "still there?" });
    expect(h.conn.sendMessage("c1", "still there?")).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    h.last().open();
    await flush();
    expect(h.last().sent).toContainEqual({
      type: "message",
      client_id: "c1",
      text: "still there?",
    });
    h.conn.stop();
  });

  it("stops for good on ended, forbidden and replaced closes", async () => {
    for (const [code, reason] of [
      [WS_CLOSE.ended, "ended"],
      [WS_CLOSE.forbidden, "forbidden"],
      [WS_CLOSE.replaced, "replaced"],
    ] as const) {
      const h = harness();
      h.conn.start();
      await flush();
      h.last().open();
      await flush();
      h.last().drop(code);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.sockets).toHaveLength(1);
      expect(h.state.connection).toBe("closed");
      expect(h.state.closeReason).toBe(reason);
    }
  });

  it("gets a fresh ticket after a bad-ticket close", async () => {
    const h = harness();
    h.conn.start();
    await flush();
    h.last().drop(WS_CLOSE.badTicket);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.sockets).toHaveLength(2);
    expect(h.last().url).toContain("ticket=t2");
    h.conn.stop();
  });

  it("does not reconnect once the session has ended", async () => {
    const h = harness();
    h.conn.start();
    await flush();
    h.last().open();
    await flush();
    h.last().frame({
      type: "ended",
      session: session({ status: "completed", end_reason: "user_ended" }),
    });
    h.last().drop(1006);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sockets).toHaveLength(1);
    expect(h.state.connection).toBe("closed");
  });

  it("gives up when the ticket is refused (not a participant)", async () => {
    const h = harness({ ticketFails: [404] });
    h.conn.start();
    await flush();
    expect(h.state.closeReason).toBe("forbidden");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sockets).toHaveLength(0);
  });

  it("drops a silent (half-open) link and reconnects", async () => {
    const h = harness();
    h.conn.start();
    await flush();
    h.last().open();
    await flush();
    await vi.advanceTimersByTimeAsync(STALE_AFTER_MS + 20_000);
    expect(h.sockets[0]!.closedWith).toBe(4900);
    expect(h.sockets.length).toBeGreaterThanOrEqual(2);
    h.conn.stop();
  });

  it("throttles typing frames", async () => {
    const h = harness();
    h.conn.start();
    await flush();
    h.last().open();
    await flush();
    h.conn.typing();
    h.conn.typing();
    await vi.advanceTimersByTimeAsync(3000);
    h.conn.typing();
    expect(h.last().sent.filter((f) => (f as { type: string }).type === "typing")).toHaveLength(2);
    h.conn.stop();
  });

  it("stop closes the socket and cancels a pending reconnect", async () => {
    const h = harness();
    h.conn.start();
    await flush();
    h.last().open();
    await flush();
    h.last().drop();
    h.conn.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sockets).toHaveLength(1);
  });
});

describe("loadAll", () => {
  it("pages through after_seq until a short page", async () => {
    const all = Array.from({ length: BACKFILL_PAGE + 5 }, (_, i) => msg(i + 1));
    const fetchMessages = vi.fn(async (after: number, limit: number) =>
      all.filter((m) => m.seq > after).slice(0, limit),
    );
    let state = initialChatState("astrologer");
    await loadAll(fetchMessages, (a) => (state = chatReducer(state, a)), 0);
    expect(fetchMessages.mock.calls).toEqual([
      [0, BACKFILL_PAGE],
      [BACKFILL_PAGE, BACKFILL_PAGE],
    ]);
    expect(state.messages).toHaveLength(BACKFILL_PAGE + 5);
  });
});
