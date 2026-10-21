import type {
  ChatMessage,
  ParticipantRole,
  ServerEvent,
  SessionStatus,
  SessionView,
} from "@astro/shared";

/**
 * Chat room state for the astrologer console. Pure: every input (socket frames, REST backfill,
 * the astrologer's own sends, connection changes) is an action, and time is passed in.
 * Kept small and local on purpose (apps/web has its own copy for the client side).
 */

export type Connection = "idle" | "connecting" | "open" | "reconnecting" | "closed";
export type CloseReason = "ended" | "replaced" | "forbidden" | null;

export interface Pending {
  client_id: string;
  text: string;
  status: "sending" | "failed";
}

export interface ChatState {
  role: ParticipantRole;
  session: SessionView | null;
  /** Unique by seq, ascending. */
  messages: ChatMessage[];
  /** Own messages not yet echoed by the server, in the order they were typed. */
  pending: Pending[];
  connection: Connection;
  closeReason: CloseReason;
  peerTypingUntil: number | null;
  lowBalanceMinutes: number | null;
  error: { code: string; message: string } | null;
  /** server_time − local clock at the last hello, for an accurate elapsed timer. */
  serverOffsetMs: number;
  /** Calls only: who is in the audio room, from the socket's `call` event (null until known). */
  callJoined: Record<ParticipantRole, boolean> | null;
}

export type ChatAction =
  | { type: "server"; event: ServerEvent; now: number }
  | { type: "backfill"; messages: ChatMessage[] }
  | { type: "session"; session: SessionView }
  | { type: "send"; client_id: string; text: string }
  | { type: "retry"; client_id: string }
  | { type: "connection"; connection: Connection; closeReason?: CloseReason }
  | { type: "dismiss_error" };

export const TYPING_SHOW_MS = 5000;

const TERMINAL: readonly SessionStatus[] = ["completed", "cancelled", "failed"];

export function isTerminal(status: SessionStatus | undefined): boolean {
  return status !== undefined && TERMINAL.includes(status);
}

export function initialChatState(
  role: ParticipantRole,
  session: SessionView | null = null,
): ChatState {
  return {
    role,
    session,
    messages: [],
    pending: [],
    connection: "idle",
    closeReason: null,
    peerTypingUntil: null,
    lowBalanceMinutes: null,
    error: null,
    serverOffsetMs: 0,
    callJoined: null,
  };
}

/** Highest seq held, for `GET …/messages?after_seq=`. */
export function lastSeq(state: Pick<ChatState, "messages">): number {
  const last = state.messages[state.messages.length - 1];
  return last ? last.seq : 0;
}

/** Merge messages: one per seq (the first copy wins, the server never rewrites one), ordered by seq. */
export function mergeMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  if (incoming.length === 0) return existing;
  const bySeq = new Map<number, ChatMessage>();
  for (const m of existing) bySeq.set(m.seq, m);
  let changed = false;
  for (const m of incoming) {
    if (!Number.isInteger(m.seq) || bySeq.has(m.seq)) continue;
    bySeq.set(m.seq, m);
    changed = true;
  }
  if (!changed) return existing;
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** Never let a late frame move a finished session back to an open state. */
function nextSession(current: SessionView | null, incoming: SessionView): SessionView {
  if (
    current &&
    current.id === incoming.id &&
    isTerminal(current.status) &&
    !isTerminal(incoming.status)
  ) {
    return current;
  }
  return incoming;
}

function withMessages(state: ChatState, incoming: ChatMessage[]): ChatState {
  const messages = mergeMessages(state.messages, incoming);
  const echoed = new Set(
    incoming.filter((m) => m.sender === state.role && m.client_id).map((m) => m.client_id),
  );
  const pending = echoed.size
    ? state.pending.filter((p) => !echoed.has(p.client_id))
    : state.pending;
  const peerSpoke = incoming.some((m) => m.sender !== state.role && m.sender !== "system");
  if (messages === state.messages && pending === state.pending && !peerSpoke) return state;
  return { ...state, messages, pending, peerTypingUntil: peerSpoke ? null : state.peerTypingUntil };
}

function failSending(pending: Pending[]): Pending[] {
  return pending.some((p) => p.status === "sending")
    ? pending.map((p) => (p.status === "sending" ? { ...p, status: "failed" as const } : p))
    : pending;
}

/** Codes after which messages still marked "sending" were refused, not merely delayed. */
const SEND_REFUSED = new Set([
  "session_not_active",
  "rate_limited",
  "invalid_message",
  "message_too_long",
]);

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "server": {
      const ev = action.event;
      switch (ev.type) {
        case "hello": {
          const server = Date.parse(ev.server_time);
          return {
            ...state,
            role: ev.role,
            session: nextSession(state.session, ev.session),
            serverOffsetMs: Number.isFinite(server) ? server - action.now : state.serverOffsetMs,
          };
        }
        case "state":
          return { ...state, session: nextSession(state.session, ev.session) };
        case "ended":
          return {
            ...state,
            session: ev.session,
            pending: failSending(state.pending),
            peerTypingUntil: null,
            callJoined: state.callJoined ? { user: false, astrologer: false } : null,
          };
        case "message":
          return withMessages(state, [ev.message]);
        case "typing":
          if (ev.sender === state.role) return state;
          return { ...state, peerTypingUntil: action.now + TYPING_SHOW_MS };
        case "low_balance":
          return { ...state, lowBalanceMinutes: ev.minutes_left };
        case "call":
          return {
            ...state,
            callJoined: {
              user: ev.joined.user === true,
              astrologer: ev.joined.astrologer === true,
            },
          };
        case "error":
          return {
            ...state,
            error: { code: ev.code, message: ev.message },
            pending: SEND_REFUSED.has(ev.code) ? failSending(state.pending) : state.pending,
          };
        case "pong":
          return state;
        default:
          return state;
      }
    }
    case "backfill":
      return withMessages(state, action.messages);
    case "session":
      return { ...state, session: nextSession(state.session, action.session) };
    case "send": {
      const text = action.text.trim();
      if (!text || state.pending.some((p) => p.client_id === action.client_id)) return state;
      return {
        ...state,
        pending: [...state.pending, { client_id: action.client_id, text, status: "sending" }],
      };
    }
    case "retry":
      return {
        ...state,
        pending: state.pending.map((p) =>
          p.client_id === action.client_id ? { ...p, status: "sending" } : p,
        ),
      };
    case "connection":
      return {
        ...state,
        connection: action.connection,
        closeReason: action.closeReason !== undefined ? action.closeReason : state.closeReason,
      };
    case "dismiss_error":
      return state.error ? { ...state, error: null } : state;
  }
}

/** Whether the astrologer can type now: only while the session is active and the socket open. */
export function canSend(state: ChatState): boolean {
  return state.session?.status === "active" && state.connection === "open";
}

export function isPeerTyping(state: ChatState, now: number): boolean {
  return state.peerTypingUntil !== null && state.peerTypingUntil > now;
}
