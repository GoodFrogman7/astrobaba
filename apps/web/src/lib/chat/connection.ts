import {
  CHAT_LIMITS,
  WS_CLOSE,
  type ChatMessage,
  type ClientEvent,
  type ServerEvent,
} from "@astro/shared";

/**
 * One chat socket with reconnects. Every (re)connect fetches a fresh single-use ticket from our
 * route handler, opens the socket, then backfills `messages?after_seq=<last seen>` so nothing
 * sent while we were away is lost (the reducer drops duplicates). Pings keep the server's
 * heartbeat fresh; billing depends on it (docs/api/billing.md "Metering").
 */
export type ConnStatus =
  | "connecting"
  | "open"
  | "reconnecting"
  /** Another tab or device took over this chat (close 4009); we do not fight it. */
  | "replaced"
  /** Not a participant (4003) or signed out. */
  | "forbidden"
  /** Session over, or stopped by us. */
  | "closed";

export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type SocketCtor = new (url: string) => SocketLike;

export type TicketResult =
  { ok: true; ticket: string; path: string; ws_base?: string } | { ok: false; status: number };

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

export interface ConnectionOptions {
  wsBase: string;
  getTicket(): Promise<TicketResult>;
  /** null when the history could not be loaded (the next reconnect tries again). */
  loadMessages(afterSeq: number): Promise<ChatMessage[] | null>;
  lastSeq(): number;
  onEvent(e: ServerEvent): void;
  onBackfill(messages: ChatMessage[]): void;
  onStatus(s: ConnStatus): void;
  Socket: SocketCtor;
  timers?: Timers;
  random?: () => number;
  pingIntervalMs?: number;
}

const OPEN = 1;
export const MAX_BACKOFF_MS = 30_000;

/** Exponential backoff with jitter: 1 s, 2 s, 4 s … capped at 30 s, each 50–100 % of that. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.5 + random() * 0.5));
}

/** Socket URL: NEXT_PUBLIC_API_WS_URL, else the public API URL with ws(s):, + path + ticket. */
export function socketUrl(base: string, path: string, ticket: string): string {
  const root = base.replace(/\/$/, "").replace(/^http(s?):\/\//, "ws$1://");
  return `${root}${path}?ticket=${encodeURIComponent(ticket)}`;
}

export function defaultWsBase(
  env: { ws?: string; api?: string } = {
    ws: process.env.NEXT_PUBLIC_API_WS_URL,
    api: process.env.NEXT_PUBLIC_API_URL,
  },
): string {
  if (env.ws) return env.ws;
  if (env.api) return env.api.replace(/^http(s?):\/\//, "ws$1://");
  return "ws://localhost:8000";
}

const browserTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id as ReturnType<typeof setInterval>),
};

export class ChatConnection {
  private ws: SocketLike | null = null;
  private attempt = 0;
  private retryTimer: unknown = null;
  private pingTimer: unknown = null;
  private stopped = false;
  private ended = false;
  private status: ConnStatus | null = null;
  private readonly timers: Timers;
  private readonly random: () => number;

  constructor(private readonly o: ConnectionOptions) {
    this.timers = o.timers ?? browserTimers;
    this.random = o.random ?? Math.random;
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  /** Stop for good (page left, session over). */
  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      ws.close(1000);
    }
    this.setStatus("closed");
  }

  /** Reconnect now (back online, tab visible, or "use the chat here" after 4009). */
  reconnectNow(): void {
    if (this.stopped || this.ended) return;
    if (this.ws && this.ws.readyState === OPEN) return;
    this.attempt = 0;
    if (this.retryTimer !== null) this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    void this.connect();
  }

  /** false when the socket is not open; the caller keeps the message pending and resends. */
  send(e: ClientEvent): boolean {
    if (!this.ws || this.ws.readyState !== OPEN) return false;
    try {
      this.ws.send(JSON.stringify(e));
      return true;
    } catch {
      return false;
    }
  }

  get isOpen(): boolean {
    return !!this.ws && this.ws.readyState === OPEN;
  }

  private setStatus(s: ConnStatus) {
    if (this.status === s) return;
    this.status = s;
    this.o.onStatus(s);
  }

  private clearTimers() {
    if (this.retryTimer !== null) this.timers.clearTimeout(this.retryTimer);
    if (this.pingTimer !== null) this.timers.clearInterval(this.pingTimer);
    this.retryTimer = null;
    this.pingTimer = null;
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.ended) return;
    this.setStatus(
      this.attempt === 0 && this.status !== "replaced" ? "connecting" : "reconnecting",
    );
    const t = await this.o.getTicket().catch((): TicketResult => ({ ok: false, status: 0 }));
    if (this.stopped || this.ended) return;
    if (!t.ok) {
      if (t.status === 401 || t.status === 403 || t.status === 404) {
        this.setStatus("forbidden");
        return;
      }
      if (t.status === 409) {
        // Session no longer open: nothing to connect to.
        this.ended = true;
        this.setStatus("closed");
        return;
      }
      this.scheduleRetry();
      return;
    }
    let ws: SocketLike;
    try {
      ws = new this.o.Socket(socketUrl(t.ws_base || this.o.wsBase, t.path, t.ticket));
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.pingTimer = this.timers.setInterval(
        () => this.send({ type: "ping" }),
        this.o.pingIntervalMs ?? CHAT_LIMITS.pingIntervalMs,
      );
      void this.backfill(ws);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let parsed: ServerEvent;
      try {
        parsed = JSON.parse(String(ev.data)) as ServerEvent;
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") return;
      if (parsed.type === "ended") this.ended = true;
      this.o.onEvent(parsed);
    };
    ws.onerror = () => {
      /* onclose follows and decides */
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.pingTimer !== null) this.timers.clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.stopped) return;
      if (ev.code === WS_CLOSE.ended || this.ended) {
        this.ended = true;
        this.setStatus("closed");
      } else if (ev.code === WS_CLOSE.forbidden) {
        this.setStatus("forbidden");
      } else if (ev.code === WS_CLOSE.replaced) {
        this.setStatus("replaced");
      } else {
        this.scheduleRetry();
      }
    };
  }

  private async backfill(ws: SocketLike) {
    const items = await this.o.loadMessages(this.o.lastSeq()).catch(() => null);
    if (this.ws !== ws) return;
    if (items?.length) this.o.onBackfill(items);
    this.setStatus("open");
  }

  private scheduleRetry() {
    if (this.stopped || this.ended) return;
    this.setStatus("reconnecting");
    const delay = backoffDelay(this.attempt, this.random);
    this.attempt += 1;
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }
}
