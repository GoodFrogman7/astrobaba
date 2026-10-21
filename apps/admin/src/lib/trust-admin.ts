import { formatRupees } from "./money";
import type { Parsed } from "./money-admin";

/**
 * Moderation queue and account deletion requests (docs/api/trust.md §2, §4). The queue shows
 * reason codes, counts and ids only, never chat text; one flagged message of a `safety` item can
 * be revealed on purpose (audited with the admin's id).
 */

/* ---------- Moderation queue ---------- */

export const MODERATION_KINDS = ["report", "safety", "refused"] as const;
export type ModerationKind = (typeof MODERATION_KINDS)[number];

export const MODERATION_STATUSES = ["open", "closed"] as const;
export type ModerationStatus = (typeof MODERATION_STATUSES)[number];

export const MODERATION_ACTIONS = ["dismiss", "warn", "suspend"] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

/**
 * `GET /v1/admin/moderation` item. The contract lists the fields ("astrologer, reason codes,
 * counts, session id, time") but not their names, so the obvious spellings are all accepted.
 */
export interface ModerationItem {
  id: string;
  kind?: string;
  status?: string;
  astrologer?: { id: string; display_name?: string | null; slug?: string | null } | null;
  reason?: string | null;
  reasons?: string[];
  reason_codes?: string[];
  count?: number;
  counts?: Record<string, number>;
  session_id?: string | null;
  created_at?: string;
  at?: string;
  last_at?: string | null;
  /** Safety items: what was flagged (e.g. `self_harm`) and the message's seq. */
  safety_kind?: string | null;
  message_seq?: number | null;
  /** Closed items: what was done. */
  resolution?: { action?: string; note?: string | null; at?: string; admin?: string | null } | null;
  action?: string | null;
}

export function kindFilter(input: string | undefined): ModerationKind {
  return (MODERATION_KINDS as readonly string[]).includes(input ?? "")
    ? (input as ModerationKind)
    : "report";
}

export function moderationStatusFilter(input: string | undefined): ModerationStatus {
  return input === "closed" ? "closed" : "open";
}

export const KIND_LABEL: Record<ModerationKind, string> = {
  report: "Client reports",
  safety: "Safety flags",
  refused: "Refused messages",
};

export const KIND_HELP: Record<ModerationKind, string> = {
  report:
    "Reports clients filed against an astrologer. The client's note is not shown here; decide from the reason, the counts and the session.",
  safety:
    "Sessions where a client's message matched self-harm language. The client was shown crisis helplines automatically. Reveal the flagged message only if you need it to decide.",
  refused:
    "Messages from astrologers that were refused before delivery (contact details, off-platform payment, cure or outcome claims, fear selling, remedy sales). Their text is never stored, only the reason.",
};

const REASON_LABEL: Record<string, string> = {
  // Client report reasons (trust.md §4).
  harassment: "Harassment",
  scam: "Scam",
  fear_selling: "Fear selling",
  medical_claims: "Medical or cure claims",
  off_platform: "Off-platform contact or payment",
  other: "Other",
  // Safety and refusals (trust.md §3).
  self_harm: "Self-harm language",
  contact_details: "Contact details",
  off_platform_payment: "Off-platform payment request",
  cure_claim: "Cure claim",
  guaranteed_outcome: "Guaranteed outcome",
  remedy_sale: "Remedy or gemstone sale",
};

export function reasonLabel(code: string): string {
  return REASON_LABEL[code] ?? code.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** All reason codes of an item, whichever field the API used, without duplicates. */
export function reasonCodes(item: ModerationItem): string[] {
  const all = [
    ...(item.reasons ?? []),
    ...(item.reason_codes ?? []),
    ...(item.reason ? [item.reason] : []),
    ...(item.safety_kind ? [item.safety_kind] : []),
  ].filter((c): c is string => typeof c === "string" && c.length > 0);
  return [...new Set(all)];
}

/** "3 reports · 1 strike": the item's counts, readable. */
export function countsText(item: ModerationItem): string {
  const parts: string[] = [];
  if (typeof item.count === "number") parts.push(`${item.count}×`);
  for (const [k, v] of Object.entries(item.counts ?? {})) {
    if (typeof v !== "number") continue;
    const label = k.replace(/_/g, " ");
    parts.push(`${v} ${v === 1 ? label.replace(/s$/, "") : label}`);
  }
  return parts.length ? parts.join(" · ") : "–";
}

export function itemTime(item: ModerationItem): string | null {
  return item.last_at ?? item.created_at ?? item.at ?? null;
}

export function itemOutcome(item: ModerationItem): string | null {
  const action = item.resolution?.action ?? item.action ?? null;
  if (!action) return null;
  const label = ACTION_DONE[action] ?? action;
  return item.resolution?.note ? `${label}: ${item.resolution.note}` : label;
}

const ACTION_DONE: Record<string, string> = {
  dismiss: "Dismissed",
  warn: "Warned (strike recorded)",
  suspend: "Astrologer suspended",
};

/** What each action does, shown before the admin confirms. */
export const ACTION_EFFECT: Record<ModerationAction, string> = {
  dismiss: "Closes this item with no action against the astrologer.",
  warn: "Records a strike that the astrologer sees on the Conduct page of their portal, and closes this item. Write the note so it is fit for the astrologer to read.",
  suspend:
    "Suspends the astrologer (the same suspension as on the astrologer page): their profile is hidden from the directory and public pages, and they cannot go online or take new consultations until an admin reinstates them there. Closes this item.",
};

export const ACTION_CONFIRM: Record<ModerationAction, string> = {
  dismiss: "Dismiss this item?",
  warn: "Record a strike for this astrologer?",
  suspend: "Suspend this astrologer now?",
};

export const ACTION_LABEL: Record<ModerationAction, string> = {
  dismiss: "Dismiss",
  warn: "Warn",
  suspend: "Suspend",
};

export const NOTE_MIN = 5;
export const NOTE_MAX = 500;

export function parseModerationAction(fields: {
  action: string;
  note: string;
}): Parsed<{ action: ModerationAction; note: string }> {
  if (!(MODERATION_ACTIONS as readonly string[]).includes(fields.action)) {
    return { ok: false, error: "Choose dismiss, warn or suspend." };
  }
  const note = fields.note.trim();
  if (note.length < NOTE_MIN) {
    return { ok: false, error: `Add a note saying why (at least ${NOTE_MIN} characters).` };
  }
  if (note.length > NOTE_MAX) {
    return { ok: false, error: `Keep the note under ${NOTE_MAX} characters.` };
  }
  return { ok: true, value: { action: fields.action as ModerationAction, note } };
}

export function moderationDoneText(action: ModerationAction): string {
  switch (action) {
    case "dismiss":
      return "Dismissed. The item is closed.";
    case "warn":
      return "Warning recorded. The astrologer sees the strike in their portal.";
    case "suspend":
      return "Astrologer suspended. Reinstate them from their astrologer page if needed.";
  }
}

const MODERATION_ERRORS: Record<string, string> = {
  not_found: "This item no longer exists. Reload the list.",
  already_closed: "Someone already acted on this item. Reload the list.",
  invalid_transition:
    "That action is not possible now: the item was already closed, or the astrologer is not live (only live astrologers can be suspended). Reload to see the current state.",
  not_safety_item: "Only a safety item has a flagged message to reveal.",
  message_unavailable:
    "The flagged message is no longer available (for example, the client's account was deleted).",
};

export function moderationErrorText(code: string): string | undefined {
  return MODERATION_ERRORS[code];
}

/** `GET /v1/admin/moderation/{id}/message`: the one flagged message, decrypted. */
export interface FlaggedMessage {
  text: string;
  sender?: string;
  sent_at?: string;
  seq?: number;
}

export function readFlaggedMessage(body: unknown): FlaggedMessage | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const inner = (b.message && typeof b.message === "object" ? b.message : b) as Record<
    string,
    unknown
  >;
  if (typeof inner.text !== "string") return null;
  return {
    text: inner.text,
    ...(typeof inner.sender === "string" ? { sender: inner.sender } : {}),
    ...(typeof inner.sent_at === "string" ? { sent_at: inner.sent_at } : {}),
    ...(typeof inner.seq === "number" ? { seq: inner.seq } : {}),
  };
}

/* ---------- Account deletion requests (trust.md §2) ---------- */

/**
 * `GET /v1/admin/deletions` row. The contract defines only the execute endpoint; the list is
 * assumed to carry the request, the user id, open sessions and the wallet balance.
 */
export interface DeletionRequest {
  id: string;
  user_id: string;
  status: string;
  requested_at: string;
  open_sessions?: number | boolean | null;
  wallet_balance_paise?: number | null;
  executed_at?: string | null;
}

export const DELETION_FILTERS = ["requested", "all"] as const;
export type DeletionFilter = (typeof DELETION_FILTERS)[number];

export function deletionFilter(input: string | undefined): DeletionFilter {
  return input === "all" ? "all" : "requested";
}

const DELETION_STATUS: Record<string, string> = {
  requested: "Requested",
  cancelled: "Cancelled by the user",
  executed: "Deleted",
  completed: "Deleted",
};

export function deletionStatusLabel(status: string): string {
  return DELETION_STATUS[status] ?? status.replace(/_/g, " ");
}

/** "No" / "Yes (2)" / "–" when the API did not say. */
export function openSessionsText(v: DeletionRequest["open_sessions"]): string {
  if (v === undefined || v === null) return "–";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return v > 0 ? `Yes (${v})` : "No";
}

export function balanceText(paise: number | null | undefined): string {
  return typeof paise === "number" ? formatRupees(paise) : "–";
}

/** Whether Execute is worth offering now; the API checks again and answers 409 otherwise. */
export function deletionBlockers(r: DeletionRequest): string[] {
  const out: string[] = [];
  if (r.open_sessions === true || (typeof r.open_sessions === "number" && r.open_sessions > 0)) {
    out.push("Has an open session");
  }
  if (typeof r.wallet_balance_paise === "number" && r.wallet_balance_paise !== 0) {
    out.push(`Wallet balance ${formatRupees(r.wallet_balance_paise)}`);
  }
  return out;
}

export function canExecute(r: DeletionRequest): boolean {
  return r.status === "requested";
}

export const EXECUTE_EFFECT =
  "Executing deletes this user's personal data for good: sessions and sign-ins are revoked, the phone number is replaced by a one-way hash, name and saved kundlis, chat messages, AI questions, remedy leads, reports and exports are deleted, and reviews become “Former client”. Consents and ledger rows are kept (proof and tax law). It cannot be undone; the phone number can sign up again as a new user.";

/** Plain words for the execute errors, with what to do next. */
export function deletionErrorText(code: string): string | undefined {
  switch (code) {
    case "balance_outstanding":
      return "Not deleted: the user still has money in their wallet. Settle the balance manually first: pay the real balance back to the user (for example a refund through the payment provider) and have it recorded in the ledger, check the wallet shows ₹0, then execute again. Nothing was deleted.";
    case "session_open":
      return "Not deleted: the user has a consultation that is waiting or in progress. Wait for it to end (or end it from Sessions), then execute again. Nothing was deleted.";
    case "not_found":
      return "This request no longer exists. Reload the list.";
    case "invalid_transition":
    case "not_requested":
      return "This request is no longer open (the user cancelled it, or it was already executed). Reload the list.";
    default:
      return undefined;
  }
}

/* ---------- Lists ---------- */

/** A list body as `{items, next_cursor}` or a bare array. */
export function asList<T>(body: unknown): { items: T[]; next_cursor: string | null } {
  if (Array.isArray(body)) return { items: body as T[], next_cursor: null };
  const b = (body ?? {}) as { items?: unknown; next_cursor?: unknown };
  return {
    items: Array.isArray(b.items) ? (b.items as T[]) : [],
    next_cursor: typeof b.next_cursor === "string" ? b.next_cursor : null,
  };
}
