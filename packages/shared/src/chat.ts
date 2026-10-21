/**
 * Chat session protocol shared by the web app and the astrologer console.
 * Source of truth: docs/api/billing.md. The API (Python) implements the same shapes.
 */

export const SESSION_STATUSES = [
  "queued",
  "requested",
  "accepted",
  "active",
  "completed",
  "cancelled",
  "failed",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const OPEN_SESSION_STATUSES: readonly SessionStatus[] = [
  "queued",
  "requested",
  "accepted",
  "active",
];

export const END_REASONS = [
  "user_ended",
  "astrologer_ended",
  "insufficient_funds",
  "free_minutes_used",
  "user_cancelled",
  "astrologer_declined",
  "request_timeout",
  "join_timeout",
  "user_dropped",
  "astrologer_dropped",
  "admin",
] as const;
export type EndReason = (typeof END_REASONS)[number];

export type ParticipantRole = "user" | "astrologer";

export interface SessionView {
  id: string;
  kind: "chat";
  status: SessionStatus;
  end_reason: EndReason | null;
  role: ParticipantRole;
  astrologer: { id: string; slug: string; display_name: string };
  /** Never the client's phone or name: "Client" plus a short stable label. */
  client_label: string;
  price_per_min_paise: number;
  is_free: boolean;
  free_minutes: number | null;
  queue: { position: number; eta_minutes: number | null } | null;
  created_at: string;
  accepted_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  billed_minutes: number;
  billed_paise: number;
  /** User only: whole minutes the wallet still covers; null for the astrologer. */
  minutes_left: number | null;
  can_review: boolean;
}

export interface ChatMessage {
  id: string;
  seq: number;
  sender: ParticipantRole | "system";
  text: string;
  sent_at: string;
  /** Echoed back to the sender so it can match its optimistic copy. */
  client_id: string | null;
}

export type ServerEvent =
  | { type: "hello"; role: ParticipantRole; session: SessionView; server_time: string }
  | { type: "state"; session: SessionView }
  | { type: "message"; message: ChatMessage }
  | { type: "typing"; sender: ParticipantRole }
  | { type: "low_balance"; minutes_left: number }
  | { type: "ended"; session: SessionView }
  | { type: "error"; code: string; message: string }
  | { type: "pong" };

export type ClientEvent =
  { type: "message"; client_id: string; text: string } | { type: "typing" } | { type: "ping" };

/**
 * `text` of a `sender: "system"` message is a code, never personal data: `session_started`,
 * `low_balance`, or `session_ended:<EndReason>`.
 */
export const SYSTEM_MESSAGE_CODES = ["session_started", "low_balance", "session_ended"] as const;

/** Limits mirrored by the server. */
export const CHAT_LIMITS = {
  maxMessageChars: 2000,
  pingIntervalMs: 20_000,
} as const;

/** WebSocket close codes the server uses (4000-4999 are application codes). */
export const WS_CLOSE = {
  ended: 4000,
  badTicket: 4001,
  forbidden: 4003,
  replaced: 4009,
} as const;
