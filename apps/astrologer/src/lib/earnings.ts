import { calendarDate, IST, type EarningTotals, type PayoutStatus } from "@astro/shared";
import { formatRupees } from "./format";

/**
 * Earnings and payout display helpers (docs/api/portal.md §2.3, §2.5, §3). Dates are IST
 * calendar dates ("YYYY-MM-DD"); money stays integer paise and becomes ₹ text only here.
 */

export const MAX_RANGE_DAYS = 366;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 3600 * 1000;

export function isIsoDate(v: string): boolean {
  if (!DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Inclusive day count between two valid dates (1 when equal). */
export function daysInclusive(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

function lastDayOfMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** First and last day of the IST month `offset` months from now's IST month (0 = this month). */
export function istMonthRange(now: Date, offset = 0): { from: string; to: string } {
  const [y, m] = calendarDate(now, IST).split("-").map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + offset;
  const year = Math.floor(idx / 12);
  const month1 = (idx % 12) + 1;
  const mm = String(month1).padStart(2, "0");
  return {
    from: `${year}-${mm}-01`,
    to: `${year}-${mm}-${String(lastDayOfMonth(year, month1)).padStart(2, "0")}`,
  };
}

export type PeriodKind = "this_month" | "last_month" | "custom";

export interface Period {
  kind: PeriodKind;
  from: string;
  to: string;
  /** Set when a custom range was refused; the period then falls back to this month. */
  error: string | null;
}

/**
 * The earnings period from the page's query: `period=this_month|last_month|custom` with `from`
 * and `to` for custom. This month runs from the 1st to today (IST); custom ranges are checked
 * like the API (real dates, from ≤ to, at most 366 days) and may not start in the future.
 */
export function resolvePeriod(
  q: { period?: string; from?: string; to?: string },
  now: Date = new Date(),
): Period {
  const today = calendarDate(now, IST);
  const thisMonth = { kind: "this_month" as const, from: istMonthRange(now).from, to: today };
  if (q.period === "last_month")
    return { kind: "last_month", ...istMonthRange(now, -1), error: null };
  if (q.period !== "custom") return { ...thisMonth, error: null };
  const from = (q.from ?? "").trim();
  const to = (q.to ?? "").trim();
  const fail = (error: string): Period => ({ ...thisMonth, error });
  if (!isIsoDate(from) || !isIsoDate(to)) return fail("Choose both a start and an end date.");
  if (from > to) return fail("The start date must be on or before the end date.");
  if (from > today) return fail("The start date cannot be in the future.");
  if (daysInclusive(from, to) > MAX_RANGE_DAYS) {
    return fail(`Choose a range of at most ${MAX_RANGE_DAYS} days.`);
  }
  return { kind: "custom", from, to, error: null };
}

/** Query for `GET /v1/astrologer/me/earnings`. */
export function earningsQuery(p: { from: string; to: string }, cursor?: string, limit = 25) {
  const q = new URLSearchParams({ from: p.from, to: p.to, limit: String(limit) });
  if (cursor) q.set("cursor", cursor);
  return q.toString();
}

/** Link back to the earnings page for a period (and optionally a page of sessions). */
export function earningsHref(p: Period, cursor?: string): string {
  const q = new URLSearchParams({ period: p.kind });
  if (p.kind === "custom") {
    q.set("from", p.from);
    q.set("to", p.to);
  }
  if (cursor) q.set("cursor", cursor);
  return `/earnings?${q}`;
}

/** "21 Oct 2026" for an IST calendar date (no zone shift: the date is already IST). */
export function formatDate(date: string): string {
  if (!isIsoDate(date)) return date;
  return new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", dateStyle: "medium" }).format(
    new Date(`${date}T00:00:00Z`),
  );
}

export function formatRange(from: string, to: string): string {
  return from === to ? formatDate(from) : `${formatDate(from)} – ${formatDate(to)}`;
}

/** "YYYY-MM" → "September 2026". */
export function formatMonth(period: string): string {
  if (!/^\d{4}-\d{2}$/.test(period) || !isIsoDate(`${period}-01`)) return period;
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  }).format(new Date(`${period}-01T00:00:00Z`));
}

/** "45 min", "1 h", "2 h 5 min". */
export function formatMinutes(n: number): string {
  const m = Math.max(0, Math.trunc(n));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** A deduction (commission, refunds) shown as a negative amount; zero stays "₹0". */
export function formatDeduction(paise: number): string {
  return paise === 0 ? formatRupees(0) : formatRupees(-Math.abs(paise));
}

/** Bar length in percent of the largest value; tiny non-zero values stay visible. */
export function barPercent(value: number, max: number): number {
  if (!(max > 0) || !(value > 0)) return 0;
  return Math.max(2, Math.min(100, Math.round((value / max) * 100)));
}

/** Days sorted by date, with each bar scaled to the largest gross of the period. */
export function dayBars<T extends EarningTotals & { date: string }>(
  days: readonly T[],
): (T & { percent: number })[] {
  const max = Math.max(0, ...days.map((d) => d.gross_paise));
  return [...days]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({ ...d, percent: barPercent(d.gross_paise, max) }));
}

export const EMPTY_TOTALS: EarningTotals = {
  gross_paise: 0,
  commission_paise: 0,
  refunds_paise: 0,
  net_paise: 0,
  sessions: 0,
  minutes: 0,
};

/* ---------- Payout statements ---------- */

export const PAYOUT_STATUS_LABEL: Record<PayoutStatus, string> = {
  draft: "Being prepared",
  approved: "Approved",
  paid: "Paid",
  void: "Not paid",
};

/** One plain sentence on what a payout's status means for the astrologer. */
export function payoutStatusText(p: {
  status: PayoutStatus | string;
  carried_forward_paise: number;
}): string {
  switch (p.status) {
    case "draft":
      return "The statement is being prepared. Figures can still change until it is approved.";
    case "approved":
      return "Approved. The bank transfer is being arranged.";
    case "paid":
      return "Paid to your bank account.";
    case "void":
      return p.carried_forward_paise > 0
        ? `Below the minimum payout, so ${formatRupees(p.carried_forward_paise)} was carried forward to the next month. Nothing is lost.`
        : "This statement was cancelled. Contact support if you have questions.";
    default:
      return String(p.status);
  }
}

export const TAX_NOTE =
  "Tax deducted at source (TDS) and GST are not modelled yet: amounts are shown before any tax treatment, which will be added once confirmed with a chartered accountant.";
