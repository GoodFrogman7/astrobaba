import { WS_CLOSE, type ChatMessage, type ServerEvent } from "@astro/shared";
import { describe, expect, it } from "vitest";
import {
  backoffDelay,
  ChatConnection,
  defaultWsBase,
  MAX_BACKOFF_MS,
  socketUrl,
  type ConnStatus,
  type SocketLike,
  type TicketResult,
  type Timers,
} from "../src/lib/chat/connection";

class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  serverSends(e: ServerEvent) {
    this.onmessage?.({ data: JSON.stringify(e) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

/** Manual clock: timers fire only when the test advances time. */
class FakeTimers implements Timers {
  now = 0;
  private next = 1;
  private jobs = new Map<number, { at: number; fn: () => void; every?: number }>();
  setTimeout(fn: () => void, ms: number) {
    const id = this.next++;
    this.jobs.set(id, { at: this.now + ms, fn });
    return id;
  }
  clearTimeout(id: unknown) {
    this.jobs.delete(id as number);
  }
  setInterval(fn: () => void, ms: number) {
    const id = this.next++;
    this.jobs.set(id, { at: this.now + ms, fn, every: ms });
    return id;
  }
  clearInterval(id: unknown) {
    this.jobs.delete(id as number);
  }
  pendingDelays() {
    return [...this.jobs.values()].filter((j) => !j.every).map((j) => j.at - this.now);
  }
  async advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.jobs.entries()]
        .filter(([, j]) => j.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, job] = due;
      this.now = job.at;
      if (job.every) job.at += job.every;
      else this.jobs.delete(id);
      job.fn();
      await flush();
    }
    this.now = end;
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(opts: { tickets?: TicketResult[]; history?: ChatMessage[][] } = {}) {
  FakeSocket.all = [];
  const timers = new FakeTimers();
  const statuses: ConnStatus[] = [];
  const events: ServerEvent[] = [];
  const backfills: ChatMessage[][] = [];
  const afterSeqs: number[] = [];
  let lastSeq = 0;
  let ticketN = 0;
  const conn = new ChatConnection({
    wsBase: "wss://api.example.test",
    Socket: FakeSocket,
    timers,
    random: () => 1,
    pingIntervalMs: 20_000,
    getTicket: async () => {
      ticketN += 1;
      return (
        opts.tickets?.[ticketN - 1] ?? {
          ok: true,
          ticket: `t${ticketN}`,
          path: "/v1/sessions/s1/ws",
        }
      );
    },
    loadMessages: async (after) => {
      afterSeqs.push(after);
      return opts.history?.shift() ?? [];
    },
    lastSeq: () => lastSeq,
    onEvent: (e) => events.push(e),
    onBackfill: (m) => {
      backfills.push(m);
      lastSeq = Math.max(lastSeq, ...m.map((x) => x.seq));
    },
    onStatus: (s) => statuses.push(s),
  });
  return {
    conn,
    timers,
    statuses,
    events,
    backfills,
    afterSeqs,
    setLastSeq: (n: number) => (lastSeq = n),
    socket: () => FakeSocket.all.at(-1)!,
  };
}

const m = (seq: number): ChatMessage => ({
  id: `m${seq}`,
  seq,
  sender: "astrologer",
  text: "x",
  sent_at: "2026-10-21T10:00:00Z",
  client_id: null,
});

describe("chat connection", () => {
  it("connects with a fresh ticket, backfills, then reports open", async () => {
    const t = setup({ history: [[m(1), m(2)]] });
    t.conn.start();
    await flush();
    expect(t.socket().url).toBe("wss://api.example.test/v1/sessions/s1/ws?ticket=t1");
    t.socket().open();
    await flush();
    expect(t.afterSeqs).toEqual([0]);
    expect(t.backfills).toEqual([[m(1), m(2)]]);
    expect(t.statuses).toEqual(["connecting", "open"]);
  });

  it("pings every interval while open and forwards server events", async () => {
    const t = setup();
    t.conn.start();
    await flush();
    t.socket().open();
    await flush();
    await t.timers.advance(40_000);
    expect(t.socket().sent.map((s) => JSON.parse(s))).toEqual([{ type: "ping" }, { type: "ping" }]);
    t.socket().serverSends({ type: "typing", sender: "astrologer" });
    t.socket().onmessage?.({ data: "not json" });
    expect(t.events).toEqual([{ type: "typing", sender: "astrologer" }]);
    expect(t.conn.send({ type: "message", client_id: "c1", text: "hi" })).toBe(true);
  });

  it("reconnects with backoff and a new ticket, and backfills after the last seq", async () => {
    const t = setup({ history: [[m(1), m(2), m(3)], [m(4)]] });
    t.conn.start();
    await flush();
    t.socket().open();
    await flush();
    const first = t.socket();
    first.drop(1006);
    expect(t.statuses.at(-1)).toBe("reconnecting");
    expect(t.conn.send({ type: "ping" })).toBe(false);
    // random() = 1 → full delay: 1 s for the first retry.
    expect(t.timers.pendingDelays()).toEqual([1000]);
    await t.timers.advance(1000);
    const second = t.socket();
    expect(second).not.toBe(first);
    expect(second.url).toContain("ticket=t2");
    second.open();
    await flush();
    expect(t.afterSeqs).toEqual([0, 3]);
    expect(t.statuses.at(-1)).toBe("open");
    // Old socket's late events are ignored.
    first.serverSends({ type: "pong" });
    expect(t.events).toEqual([]);
  });

  it("backs off exponentially when the socket keeps failing, capped at 30 s", async () => {
    const t = setup();
    t.conn.start();
    await flush();
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      t.socket().drop(1006);
      delays.push(...t.timers.pendingDelays());
      await t.timers.advance(delays.at(-1)!);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(backoffDelay(3, () => 0)).toBe(4000);
    expect(backoffDelay(50, () => 0.5)).toBe(MAX_BACKOFF_MS * 0.75);
  });

  it("stops after `ended` and close 4000; does not reconnect", async () => {
    const t = setup();
    t.conn.start();
    await flush();
    t.socket().open();
    await flush();
    t.socket().serverSends({ type: "ended", session: {} as never });
    t.socket().drop(WS_CLOSE.ended);
    expect(t.statuses.at(-1)).toBe("closed");
    expect(t.timers.pendingDelays()).toEqual([]);
    t.conn.reconnectNow();
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("4009 (opened elsewhere) waits for the user; 4003 and a refused ticket stop", async () => {
    const t = setup();
    t.conn.start();
    await flush();
    t.socket().open();
    await flush();
    t.socket().drop(WS_CLOSE.replaced);
    expect(t.statuses.at(-1)).toBe("replaced");
    expect(t.timers.pendingDelays()).toEqual([]);
    t.conn.reconnectNow();
    await flush();
    expect(FakeSocket.all).toHaveLength(2);
    t.socket().drop(WS_CLOSE.forbidden);
    expect(t.statuses.at(-1)).toBe("forbidden");

    const u = setup({ tickets: [{ ok: false, status: 401 }] });
    u.conn.start();
    await flush();
    expect(u.statuses).toEqual(["connecting", "forbidden"]);
    expect(FakeSocket.all).toHaveLength(0);
  });

  it("a failed ticket request (network, 503) is retried with backoff", async () => {
    const t = setup({ tickets: [{ ok: false, status: 503 }] });
    t.conn.start();
    await flush();
    expect(t.statuses).toEqual(["connecting", "reconnecting"]);
    await t.timers.advance(1000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("stop() closes the socket and cancels timers", async () => {
    const t = setup();
    t.conn.start();
    await flush();
    t.socket().drop(1006);
    t.conn.stop();
    expect(t.timers.pendingDelays()).toEqual([]);
    expect(t.statuses.at(-1)).toBe("closed");
  });
});

describe("socket URL", () => {
  it("uses the WS URL, else the public API URL as ws(s)", () => {
    expect(socketUrl("https://api.example.test/", "/v1/sessions/s1/ws", "a+b")).toBe(
      "wss://api.example.test/v1/sessions/s1/ws?ticket=a%2Bb",
    );
    expect(defaultWsBase({ ws: "wss://chat.example.test" })).toBe("wss://chat.example.test");
    expect(defaultWsBase({ api: "http://localhost:8000" })).toBe("ws://localhost:8000");
    expect(defaultWsBase({})).toBe("ws://localhost:8000");
  });
});
