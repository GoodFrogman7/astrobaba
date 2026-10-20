/**
 * The single source of "today" for the product (PLAN.md §5 Phase 2: one IST date source).
 *
 * Rule: the server stores and returns instants in UTC plus an IANA zone. Formatting happens
 * at the edge with an explicit zone, never in the browser's local zone.
 */
export const IST = "Asia/Kolkata";

/** Calendar date (YYYY-MM-DD) in the given zone for an instant. Defaults to IST. */
export function calendarDate(instant: Date = new Date(), timeZone: string = IST): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Today's IST date. Every title, meta tag and body on a dated page must use this value. */
export function istToday(now: Date = new Date()): string {
  return calendarDate(now, IST);
}

/** Format a UTC instant for display in an explicit zone. `timeZone` is required on purpose. */
export function formatInZone(
  instant: Date | string,
  timeZone: string,
  locale: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: "long" },
): string {
  const date = typeof instant === "string" ? new Date(instant) : instant;
  if (Number.isNaN(date.getTime())) throw new RangeError(`Invalid instant: ${String(instant)}`);
  return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(date);
}
