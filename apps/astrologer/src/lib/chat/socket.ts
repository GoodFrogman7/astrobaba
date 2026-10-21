import {
  CHAT_LIMITS,
  WS_CLOSE,
  type ChatMessage,
  type ClientEvent,
  type ServerEvent,
} from "@astro/shared";
import { isTerminal, lastSeq, type ChatAction, type ChatState } from "./reducer";

/**
 * One chat connection: ticket → WebSocket → backfill → live frames, with ping, typing and
 * reconnect-with-backoff. Pure TypeScript with every side effect injected, so it is tested with
 * a mocked socket and fake timers.
 */

/** The subset of the browser WebSocket this module uses. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export const OPEN = 1;

export class TicketError extends Error {
  constructor(public status: number) {
    super(`ticket ${status}`);
  }
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

export interface ConnectionDeps {
  /** Fetch a fresh single-use ticket and return the full ws:// URL. Throws TicketError. */
  getSocketUrl(): Promise<string>;
  /** `GET …/messages?after_seq=` (one page, ≤ limit items). */
  fetchMessages(afterSeq: number, limit: number): Promise<ChatMessage[]>;
  createSocket(url: string): SocketLike;
  dispatch(action: ChatAction): void;
  getState(): ChatState;
  now(): number;
  timers?: Timers;
  random?: () => number;
}

export const BACKFILL_PAGE = 200;
const MAX_BACKFILL_PAGES = 25;
/** No frame (not even a pong) for this long → the link is dead even if the socket says open. */
export const STALE_AFTER_MS = CHAT_LIMITS.pingIntervalMs * 2 + 5000;
export const TYPING_THROTTLE_MS = 3000;
/** Close code the client uses when it drops a silent link (3000–4999 is application space). */
const CLIENT_GAVE_UP = 4900;

/** Exponential backoff with jitter: ~1 s, 2 s, 4 s … capped at 30 s. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.5 + random() * 0.5));
}

function parseEvent(data: unknown): ServerEvent | null {
  if (typeof data !== "string") return null;
  try {
    const v = JSON.parse(data) as { type?: unknown };
    return v && typeof v === "object" && typeof v.type === "string" ? (v as ServerEvent) : null;
  } catch {
    return null;
  }
}

/**
 * Page through `messages?after_seq=` until a short page, dispatching each page as a backfill.
 * The cursor advances from the returned items, never from (possibly stale) UI state.
 */
export async function loadAll(
  fetchMessages: ConnectionDeps["fetchMessages"],
  dispatch: ConnectionDeps["dispatch"],
  afterSeq: number,
  stillWanted: () => boolean = () => true,
): Promise<void> {
  let after = afterSeq;
  for (let page = 0; page < MAX_BACKFILL_PAGES; page++) {
    const items = await fetchMessages(after, BACKFILL_PAGE);
    if (!stillWanted()) return;
    dispatch({ type: "backfill", messages: items });
    for (const m of items) after = Math.max(after, m.seq);
    if (items.length < BACKFILL_PAGE) return;
  }
}

const browserTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id as ReturnType<typeof setInterval>),
};

export class ChatConnection {
  private socket: SocketLike | null = null;
  private attempt = 0;
  private stopped = true;
  private reconnectTimer: unknown = null;
  private pingTimer: unknown = null;
  private lastFrameAt = 0;
  private lastTypingAt = -Infinity;
  private readonly timers: Timers;
  private readonly random: () => number;

  constructor(private readonly deps: ConnectionDeps) {
    this.timers = deps.timers ?? browserTimers;
    this.random = deps.random ?? Math.random;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.detach(1000);
  }

  /** Reconnect straight away (browser came back online, tab became visible). */
  reconnectNow(): void {
    if (this.stopped || this.socket) return;
    if (this.reconnectTimer !== null) this.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    void this.connect();
  }

  /** Send (or resend, with the same client_id) a message. False when the socket is not open. */
  sendMessage(client_id: string, text: string): boolean {
    return this.sendFrame({ type: "message", client_id, text });
  }

  /** Throttled typing signal. */
  typing(): void {
    const now = this.deps.now();
    if (now - this.lastTypingAt < TYPING_THROTTLE_MS) return;
    if (this.sendFrame({ type: "typing" })) this.lastTypingAt = now;
  }

  private sendFrame(ev: ClientEvent): boolean {
    const s = this.socket;
    if (!s || s.readyState !== OPEN) return false;
    try {
      s.send(JSON.stringify(ev));
      return true;
    } catch {
      return false;
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    if (isTerminal(this.deps.getState().session?.status)) {
      this.stopped = true;
      this.deps.dispatch({ type: "connection", connection: "closed", closeReason: "ended" });
      return;
    }
    this.deps.dispatch({
      type: "connection",
      connection: this.attempt === 0 ? "connecting" : "reconnecting",
    });
    let url: string;
    try {
      url = await this.deps.getSocketUrl();
    } catch (e) {
      if (this.stopped) return;
      if (e instanceof TicketError && (e.status === 401 || e.status === 403 || e.status === 404)) {
        this.finish("forbidden");
        return;
      }
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;
    const socket = this.deps.createSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.lastFrameAt = this.deps.now();
      this.deps.dispatch({ type: "connection", connection: "open" });
      this.startPing();
      void this.backfillThenResend();
    };
    socket.onmessage = (msg) => {
      if (this.socket !== socket) return;
      this.lastFrameAt = this.deps.now();
      const ev = parseEvent(msg.data);
      if (ev) this.deps.dispatch({ type: "server", event: ev, now: this.deps.now() });
    };
    socket.onerror = () => {
      /* a close event always follows */
    };
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearPing();
      this.onClosed(ev.code);
    };
  }

  private onClosed(code: number): void {
    if (this.stopped) return;
    if (code === WS_CLOSE.ended) return this.finish("ended");
    if (code === WS_CLOSE.forbidden) return this.finish("forbidden");
    if (code === WS_CLOSE.replaced) return this.finish("replaced");
    // badTicket (expired between fetch and connect) and network drops: new ticket, backoff.
    this.scheduleReconnect();
  }

  private finish(reason: "ended" | "forbidden" | "replaced"): void {
    this.stopped = true;
    this.clearTimers();
    this.deps.dispatch({ type: "connection", connection: "closed", closeReason: reason });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (isTerminal(this.deps.getState().session?.status)) return this.finish("ended");
    this.deps.dispatch({ type: "connection", connection: "reconnecting" });
    const delay = backoffMs(this.attempt, this.random);
    this.attempt += 1;
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  /** After every (re)connect: load what was missed, then resend own unconfirmed messages. */
  private async backfillThenResend(): Promise<void> {
    const socket = this.socket;
    try {
      await loadAll(
        this.deps.fetchMessages,
        this.deps.dispatch,
        lastSeq(this.deps.getState()),
        () => this.socket === socket,
      );
    } catch {
      // Live frames still arrive; the next reconnect backfills again.
    }
    if (this.socket !== socket) return;
    for (const p of this.deps.getState().pending) {
      if (p.status === "sending") this.sendMessage(p.client_id, p.text);
    }
  }

  private startPing(): void {
    this.clearPing();
    this.pingTimer = this.timers.setInterval(() => {
      const s = this.socket;
      if (!s) return;
      if (this.deps.now() - this.lastFrameAt > STALE_AFTER_MS) {
        // Half-open link: drop it and reconnect with a new ticket.
        this.detach(CLIENT_GAVE_UP);
        this.clearPing();
        this.scheduleReconnect();
        return;
      }
      this.sendFrame({ type: "ping" });
    }, CHAT_LIMITS.pingIntervalMs);
  }

  private clearPing(): void {
    if (this.pingTimer !== null) this.timers.clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private clearTimers(): void {
    this.clearPing();
    if (this.reconnectTimer !== null) this.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /** Close the current socket without reacting to its close event. */
  private detach(code: number): void {
    const s = this.socket;
    this.socket = null;
    if (!s) return;
    s.onopen = null;
    s.onmessage = null;
    s.onerror = null;
    s.onclose = null;
    try {
      s.close(code);
    } catch {
      /* already closed */
    }
  }
}
