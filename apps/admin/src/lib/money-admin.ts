import { calendarDate, IST } from "@astro/shared";
import type { ActionResult } from "./result";
import { rupeesToPaise } from "./money";
import type { AdminWalletView, ReconCheck, Wallet, WalletTxn } from "./types";

/* ---------- Idempotency keys (billing.md: 8–128 chars of [A-Za-z0-9_-]) ---------- */

export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;

/** 128 random bits; getRandomValues also works on plain-http origins (randomUUID does not). */
export function newIdempotencyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `adm_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * One key per refund the admin means to make: kept while the outcome is unknown (so a retry
 * cannot pay twice), replaced after any definite answer (success or a clear refusal).
 */
export function keyAfter(current: string, result: ActionResult | null): string {
  if (!result) return current;
  if (!result.ok && result.retryable) return current;
  return newIdempotencyKey();
}

/* ---------- Form parsing ---------- */

export const ID = /^[A-Za-z0-9_-]{1,64}$/;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export interface RefundInput {
  key: string;
  body: { session_id: string; amount_paise: number; note: string };
}

export function parseRefund(fields: {
  session_id: string;
  amount_rupees: string;
  note: string;
  idempotency_key: string;
}): Parsed<RefundInput> {
  if (!ID.test(fields.session_id)) return { ok: false, error: "Enter a valid session id." };
  const paise = rupeesToPaise(fields.amount_rupees);
  if (paise === null || paise <= 0) {
    return { ok: false, error: "Enter an amount in rupees above zero, e.g. 50 or 49.50." };
  }
  const note = fields.note.trim();
  if (note.length < 5) return { ok: false, error: "Add a note (at least 5 characters)." };
  if (note.length > 500) return { ok: false, error: "Keep the note under 500 characters." };
  if (!IDEMPOTENCY_KEY.test(fields.idempotency_key)) {
    return { ok: false, error: "The form expired. Reload the page and try again." };
  }
  return {
    ok: true,
    value: {
      key: fields.idempotency_key,
      body: { session_id: fields.session_id, amount_paise: paise, note },
    },
  };
}

export const OVERRIDE_ACTIONS = ["allow", "block", "reset"] as const;
export type OverrideAction = (typeof OVERRIDE_ACTIONS)[number];

export function parseOverride(
  userId: string,
  fields: { action: string; note: string },
): Parsed<{ user_id: string; action: OverrideAction; note: string }> {
  if (!ID.test(userId)) return { ok: false, error: "Unknown user." };
  if (!(OVERRIDE_ACTIONS as readonly string[]).includes(fields.action)) {
    return { ok: false, error: "Choose allow, block or reset." };
  }
  const note = fields.note.trim();
  if (note.length < 3) return { ok: false, error: "A note is required." };
  return { ok: true, value: { user_id: userId, action: fields.action as OverrideAction, note } };
}

/** A reconciliation date: YYYY-MM-DD, a real day, not after today in IST. */
export function parseReconDate(input: string, now: Date = new Date()): Parsed<string> {
  const v = input.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return { ok: false, error: "Pick a date." };
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
    return { ok: false, error: "That date does not exist." };
  }
  if (v > calendarDate(now, IST)) return { ok: false, error: "The date cannot be in the future." };
  return { ok: true, value: v };
}

/** Yesterday in IST: the reconciliation job's default date. */
export function yesterdayIst(now: Date = new Date()): string {
  return calendarDate(new Date(now.getTime() - 24 * 3600 * 1000), IST);
}

/* ---------- Response shapes (tolerant: the API is being built against the same contract) ---------- */

/** Lists come as `{items: [...]}` (paged) or a bare array. */
export function asItems<T>(body: unknown): { items: T[]; next_cursor: string | null } {
  if (Array.isArray(body)) return { items: body as T[], next_cursor: null };
  if (body && typeof body === "object" && Array.isArray((body as { items?: unknown }).items)) {
    const b = body as { items: T[]; next_cursor?: string | null };
    return { items: b.items, next_cursor: b.next_cursor ?? null };
  }
  return { items: [], next_cursor: null };
}

/**
 * `GET /v1/admin/money/users/{id}/wallet` is "Wallet + recent WalletTxn": accept either
 * `{wallet, transactions}` or the Wallet fields at the top level with `transactions`/`items`.
 */
export function normaliseWallet(body: unknown): AdminWalletView {
  const b = (body ?? {}) as Record<string, unknown>;
  const wallet = (b.wallet && typeof b.wallet === "object" ? b.wallet : b) as Wallet;
  const txns = (
    Array.isArray(b.transactions)
      ? b.transactions
      : Array.isArray(b.recent_transactions)
        ? b.recent_transactions
        : Array.isArray(b.items)
          ? b.items
          : []
  ) as WalletTxn[];
  return { wallet, transactions: txns };
}

export function checkView(c: ReconCheck | string): ReconCheck {
  return typeof c === "string" ? { name: c, status: "ok" } : c;
}

/* ---------- Display ---------- */

const RULES: Record<string, string> = {
  manual: "Manual (goodwill)",
  failed_connect: "Failed to connect",
  astrologer_drop: "Astrologer dropped",
  astrologer_dropped: "Astrologer dropped",
  service_unavailable: "Voice service outage",
  low_rating: "Low rating",
};

export function ruleLabel(rule: string): string {
  return RULES[rule] ?? rule.replace(/_/g, " ");
}

const TXN: Record<string, string> = {
  recharge: "Recharge",
  recharge_bonus: "Recharge bonus",
  consultation: "Consultation",
  refund: "Refund",
  free_session_grant: "Free session",
  promo_expiry: "Promo expired",
  adjustment: "Adjustment",
};

export function txnLabel(kind: string): string {
  return TXN[kind] ?? kind.replace(/_/g, " ");
}

export function formatIst(iso: string | null | undefined): string {
  if (!iso) return "–";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "–";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: IST,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}
