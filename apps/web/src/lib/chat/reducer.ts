import {
  OPEN_SESSION_STATUSES,
  type ChatMessage,
  type ParticipantRole,
  type ServerEvent,
  type SessionStatus,
  type SessionView,
} from "@astro/shared";

/**
 * Client-side chat state as a pure reducer, so ordering, de-duplication and the end of a
 * session are unit-tested without a socket. The server is the source of truth: confirmed
 * messages are ordered by `seq`; our own optimistic copies wait in `pending` until the server
 * echoes them back with the same `client_id`.
 */
export interface PendingMessage {
  client_id: string;
  text: string;
  status: "sending" | "failed";
  created_at: number;
}

export interface ChatState {
  session: SessionView | null;
  messages: ChatMessage[];
  pending: PendingMessage[];
  lastSeq: number;
  /** Epoch ms until which the other side's "typing…" shows; 0 when not typing. */
  typingUntil: number;
  /** From the last `low_balance` event; null when none. */
  lowBalanceMinutes: number | null;
  /** server clock − local clock, from `hello`, so the timer matches the server's minutes. */
  serverOffsetMs: number;
  lastError: string | null;
  /** The newest message from the other side or the system, for the screen-reader live region. */
  announce: ChatMessage | null;
  /** Calls only: who is in the audio room, from the last `call` event; null until one arrives. */
  callJoined: Record<ParticipantRole, boolean> | null;
}

export const initialChatState: ChatState = {
  session: null,
  messages: [],
  pending: [],
  lastSeq: 0,
  typingUntil: 0,
  lowBalanceMinutes: null,
  serverOffsetMs: 0,
  lastError: null,
  announce: null,
  callJoined: null,
};

export type ChatAction =
  | { type: "server"; event: ServerEvent; now: number }
  | { type: "session"; session: SessionView }
  | { type: "backfill"; messages: ChatMessage[] }
  | { type: "send"; client_id: string; text: string; now: number }
  | { type: "retry"; client_id: string }
  | { type: "send_failed"; client_id: string };

export const TYPING_SHOW_MS = 5000;

/** Errors that mean the newest message we sent was refused. */
const SEND_ERRORS = new Set(["rate_limited", "session_not_active", "message_invalid", "too_long"]);

const RANK: Record<SessionStatus, number> = {
  queued: 0,
  requested: 1,
  accepted: 2,
  active: 3,
  completed: 4,
  cancelled: 4,
  failed: 4,
};

export function isOpen(status: SessionStatus): boolean {
  return OPEN_SESSION_STATUSES.includes(status);
}

export function isTerminal(status: SessionStatus): boolean {
  return !isOpen(status);
}

/**
 * Sessions only move forward. A slower response (a poll that left before a socket `state`) must
 * not take the screen back from "active" to "accepted", or from "completed" to "active".
 */
export function mergeSession(current: SessionView | null, next: SessionView): SessionView {
  if (!current || current.id !== next.id) return next;
  if (RANK[next.status] < RANK[current.status]) return current;
  if (isTerminal(current.status) && isTerminal(next.status) && current.status !== next.status)
    return current;
  return next;
}

function insertMessages(state: ChatState, incoming: ChatMessage[]): ChatState {
  const seen = new Set(state.messages.map((m) => m.seq));
  const fresh = incoming.filter((m) => {
    if (seen.has(m.seq)) return false;
    seen.add(m.seq);
    return true;
  });
  if (!fresh.length) return state;
  const echoed = new Set(fresh.map((m) => m.client_id).filter((c): c is string => !!c));
  const messages = [...state.messages, ...fresh].sort((a, b) => a.seq - b.seq);
  return {
    ...state,
    messages,
    pending: state.pending.filter((p) => !echoed.has(p.client_id)),
    lastSeq: Math.max(state.lastSeq, ...fresh.map((m) => m.seq)),
  };
}

function failNewestSending(pending: PendingMessage[]): PendingMessage[] {
  const idx = pending.map((p) => p.status).lastIndexOf("sending");
  if (idx < 0) return pending;
  return pending.map((p, i) => (i === idx ? { ...p, status: "failed" } : p));
}

function onServer(state: ChatState, event: ServerEvent, now: number): ChatState {
  switch (event.type) {
    case "hello":
      return {
        ...state,
        session: mergeSession(state.session, event.session),
        serverOffsetMs: Number.isNaN(Date.parse(event.server_time))
          ? state.serverOffsetMs
          : Date.parse(event.server_time) - now,
      };
    case "state":
      return { ...state, session: mergeSession(state.session, event.session) };
    case "message": {
      const next = insertMessages(state, [event.message]);
      if (next === state) return state;
      const mine = state.session ? event.message.sender === state.session.role : false;
      return {
        ...next,
        typingUntil: mine ? next.typingUntil : 0,
        announce: mine ? next.announce : event.message,
      };
    }
    case "typing":
      if (state.session && event.sender === state.session.role) return state;
      return { ...state, typingUntil: now + TYPING_SHOW_MS };
    case "low_balance":
      return {
        ...state,
        lowBalanceMinutes: event.minutes_left,
        session: state.session ? { ...state.session, minutes_left: event.minutes_left } : null,
      };
    case "ended":
      return {
        ...state,
        // The `ended` frame is final: take it even over a terminal state we guessed earlier.
        session: event.session,
        typingUntil: 0,
        pending: state.pending.map((p) => ({ ...p, status: "failed" as const })),
      };
    case "error":
      return {
        ...state,
        lastError: event.code,
        pending: SEND_ERRORS.has(event.code) ? failNewestSending(state.pending) : state.pending,
      };
    case "call":
      return {
        ...state,
        callJoined: { user: !!event.joined?.user, astrologer: !!event.joined?.astrologer },
      };
    case "pong":
      return state;
    default:
      return state;
  }
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "server":
      return onServer(state, action.event, action.now);
    case "session": {
      const session = mergeSession(state.session, action.session);
      return session === state.session ? state : { ...state, session };
    }
    case "backfill":
      return insertMessages(state, action.messages);
    case "send":
      if (state.pending.some((p) => p.client_id === action.client_id)) return state;
      return {
        ...state,
        lastError: null,
        pending: [
          ...state.pending,
          {
            client_id: action.client_id,
            text: action.text,
            status: "sending",
            created_at: action.now,
          },
        ],
      };
    case "retry":
      return {
        ...state,
        lastError: null,
        pending: state.pending.map((p) =>
          p.client_id === action.client_id ? { ...p, status: "sending" } : p,
        ),
      };
    case "send_failed":
      return {
        ...state,
        pending: state.pending.map((p) =>
          p.client_id === action.client_id ? { ...p, status: "failed" } : p,
        ),
      };
    default:
      return state;
  }
}

/** Whole seconds since the chat started, on the server's clock. */
export function elapsedSeconds(session: SessionView | null, now: number, offsetMs: number): number {
  if (!session?.started_at) return 0;
  const end = session.ended_at ? Date.parse(session.ended_at) : now + offsetMs;
  return Math.max(0, Math.floor((end - Date.parse(session.started_at)) / 1000));
}

export function typingVisible(state: ChatState, now: number): boolean {
  return state.typingUntil > now;
}

/** Trimmed text within the server's limits, or null when it cannot be sent. */
export function cleanMessage(text: string, max: number): string | null {
  const t = text.trim();
  return t.length >= 1 && t.length <= max ? t : null;
}
