import { calendarDate, IST, PAYOUT_STATUSES, type PayoutStatus } from "@astro/shared";
import { formatRupees } from "./money";
import type { Parsed } from "./money-admin";
import type { AdminPayout } from "./types";

/**
 * Admin payout helpers (docs/api/portal.md §3). Periods are IST months ("YYYY-MM"); money is
 * integer paise and only becomes ₹ text for display.
 */

export { PAYOUT_STATUSES };

const PERIOD = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** The IST month of an instant, "YYYY-MM". */
export function istMonth(now: Date = new Date()): string {
  return calendarDate(now, IST).slice(0, 7);
}

/** The previous IST month: what the monthly job generates on the 1st. */
export function previousIstMonth(now: Date = new Date()): string {
  const [y, m] = istMonth(now).split("-").map(Number) as [number, number];
  const idx = y * 12 + (m - 1) - 1;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

/** A period filter from the query string: a valid "YYYY-MM", else the previous IST month. */
export function periodFilter(input: string | undefined, now: Date = new Date()): string {
  return input && PERIOD.test(input) ? input : previousIstMonth(now);
}

/** Generation needs a month that has ended (IST): earlier months only. */
export function parseGeneratePeriod(input: string, now: Date = new Date()): Parsed<string> {
  const v = input.trim();
  if (!PERIOD.test(v)) return { ok: false, error: "Choose a month (YYYY-MM)." };
  if (v >= istMonth(now)) {
    return {
      ok: false,
      error:
        "Statements can only be generated for a month that has ended (IST). The monthly job does the previous month on the 1st.",
    };
  }
  return { ok: true, value: v };
}

export function statusFilter(input: string | undefined): PayoutStatus | null {
  return (PAYOUT_STATUSES as readonly string[]).includes(input ?? "")
    ? (input as PayoutStatus)
    : null;
}

/** Bank reference (UTR or similar): letters, digits, "/", "_" and "-", 4–64 characters. */
export const BANK_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9/_-]{3,63}$/;

export function parseMarkPaid(
  fields: { reference: string; paid_on: string },
  now: Date = new Date(),
): Parsed<{ reference: string; paid_on: string }> {
  const reference = fields.reference.trim();
  if (!BANK_REFERENCE.test(reference)) {
    return {
      ok: false,
      error: "Enter the bank reference (UTR) exactly as on the bank statement: letters and digits.",
    };
  }
  const d = fields.paid_on.trim();
  const date = new Date(`${d}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(d) ||
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== d
  ) {
    return { ok: false, error: "Enter the date the bank paid it." };
  }
  if (d > calendarDate(now, IST)) {
    return { ok: false, error: "The paid-on date cannot be in the future." };
  }
  return { ok: true, value: { reference, paid_on: d } };
}

export function parseVoidNote(note: string): Parsed<{ note: string }> {
  const n = note.trim();
  if (n.length < 5) return { ok: false, error: "Add a note saying why (at least 5 characters)." };
  if (n.length > 500) return { ok: false, error: "Keep the note under 500 characters." };
  return { ok: true, value: { note: n } };
}

/* ---------- Errors in plain words ---------- */

const ERRORS: Record<string, string> = {
  exceeds_payable:
    "Not marked paid: the net amount is more than the astrologer's payable balance in the ledger (for example, a refund was posted after the statement was made). Nothing was posted. Check the balance, then void the statement if it is wrong.",
  invalid_transition:
    "This statement is no longer in a state that allows that (someone may have just changed it). Reload the page.",
  invalid_status:
    "This statement is no longer in a state that allows that (someone may have just changed it). Reload the page.",
  not_found: "This statement no longer exists. Reload the list.",
  already_paid: "This statement is already marked paid.",
  invalid_period: "That month can't be used for statements.",
  period_not_closed: "That month has not ended yet (IST).",
  idempotency_conflict: "A different request with the same key was already processed. Reload.",
};

/** Plain-language message for a payout API error; falls back to the API's own message. */
export function payoutErrorText(code: string, message: string): string | undefined {
  if (ERRORS[code]) return ERRORS[code];
  if (/period/.test(code)) return `That month can't be used: ${message || code}`;
  return undefined;
}

/* ---------- Display ---------- */

export const STATUS_LABEL: Record<PayoutStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  paid: "Paid",
  void: "Void",
};

export function statusLabel(s: string): string {
  return STATUS_LABEL[s as PayoutStatus] ?? s;
}

/** What an admin may do next with a payout in this status. */
export function allowedActions(status: string): { approve: boolean; pay: boolean; void: boolean } {
  return {
    approve: status === "draft",
    pay: status === "approved",
    void: status === "draft" || status === "approved",
  };
}

export interface PayoutTotals {
  count: number;
  gross_paise: number;
  commission_paise: number;
  refunds_paise: number;
  net_paise: number;
  carried_forward_paise: number;
  /** Net of rows that are not void: what this list would pay out. */
  payable_net_paise: number;
}

export function sumPayouts(rows: readonly AdminPayout[]): PayoutTotals {
  const t: PayoutTotals = {
    count: rows.length,
    gross_paise: 0,
    commission_paise: 0,
    refunds_paise: 0,
    net_paise: 0,
    carried_forward_paise: 0,
    payable_net_paise: 0,
  };
  for (const r of rows) {
    t.gross_paise += r.gross_paise;
    t.commission_paise += r.commission_paise;
    t.refunds_paise += r.refunds_paise;
    t.net_paise += r.net_paise;
    t.carried_forward_paise += r.carried_forward_paise ?? 0;
    if (r.status !== "void") t.payable_net_paise += r.net_paise;
  }
  return t;
}

/** "YYYY-MM" → "September 2026". */
export function formatPeriod(period: string): string {
  if (!PERIOD.test(period)) return period;
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  }).format(new Date(`${period}-01T00:00:00Z`));
}

export function astrologerName(p: AdminPayout): string {
  return p.astrologer?.display_name ?? p.astrologer_id ?? p.astrologer?.id ?? "Unknown astrologer";
}

/** The ledger posting that "Mark paid" creates (portal.md §3), spelled out for the confirm step. */
export function markPaidConsequence(p: AdminPayout): string {
  const acct = p.astrologer?.id ?? p.astrologer_id ?? "{astrologer}";
  return `This posts ledger transaction payout:${p.id} for ${formatRupees(p.net_paise)}: debit astrologer:${acct}:payable, credit bank:payouts. It is recorded in the audit log under your account and cannot be undone from here.`;
}

export const TAX_NOTE =
  "TDS and GST are not modelled yet (pending a chartered accountant's advice); statements say so.";
