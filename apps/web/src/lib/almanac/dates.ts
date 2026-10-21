import { formatInZone, IST, istToday } from "@astro/shared";

/** Calendar-date helpers for almanac pages. Dates are IST calendar dates as "YYYY-MM-DD". */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
// The engine's ephemeris files cover 1800-2399 CE (services/astro models.MIN_DATE/MAX_DATE).
export const MIN_DATE = "1800-01-02";
export const MAX_DATE = "2399-12-30";

export function parseIsoDate(value: string): string | null {
  const m = ISO_DATE.exec(value);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.toISOString().slice(0, 10) !== value) return null; // e.g. 2026-02-30
  if (value < MIN_DATE || value > MAX_DATE) return null;
  return value;
}

export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  const toUtc = (s: string) => {
    const [y, m, d] = s.split("-").map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

/** Today and tomorrow in IST for an instant. Never uses the host or browser time zone. */
export function istDays(now: Date = new Date()): { today: string; tomorrow: string } {
  const today = istToday(now);
  return { today, tomorrow: addDays(today, 1) };
}

/**
 * "21 October 2026" / "21 अक्टूबर 2026" for an IST calendar date. Dated pages use this one string
 * in the title, the meta description and the body (PLAN.md §5 Phase 2: one IST date source).
 */
export function formatIstDate(isoDate: string, locale: "en" | "hi"): string {
  return formatInZone(`${isoDate}T12:00:00+05:30`, IST, locale === "hi" ? "hi-IN" : "en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** Clock time of a UTC instant in a place's IANA zone, e.g. "06:25". */
export function formatClock(instantUtc: string, timeZone: string): string {
  return formatInZone(instantUtc, timeZone, "en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

/** Clock time plus a short date when the instant falls on another calendar day in that zone. */
export function formatClockOnDay(
  instantUtc: string,
  timeZone: string,
  isoDate: string,
  locale: "en" | "hi",
): string {
  const clock = formatClock(instantUtc, timeZone);
  const day = formatInZone(instantUtc, timeZone, "en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  if (day === isoDate) return clock;
  const short = formatInZone(instantUtc, timeZone, locale === "hi" ? "hi-IN" : "en-IN", {
    day: "numeric",
    month: "short",
  });
  return `${clock}, ${short}`;
}
