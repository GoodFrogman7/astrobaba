import type { Availability, AvailabilitySlot } from "@astro/shared";

/**
 * The astrologer's usual weekly schedule on the public profile (docs/api/portal.md §2.1). Slots
 * are IST wall-clock times with weekday 0 = Monday; they are shown as IST, never converted, and
 * they are informational only (presence comes from the online toggle).
 */
export interface AvailabilityRow {
  /** "Mon", "Mon–Fri" or "Sat, Sun" (short names in the page's language). */
  days: string;
  /** Long names for screen readers: "Monday to Friday". */
  daysLong: string;
  /** "10:00 am – 1:00 pm, 5:00 pm – 8:00 pm". */
  times: string;
}

const HHMM = /^([01]\d|2[0-4]):([0-5]\d)$/;

function minutes(hhmm: string): number | null {
  const m = HHMM.exec(hhmm);
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v <= 24 * 60 ? v : null;
}

/** Valid slots only, by weekday then start time; anything malformed is dropped, not guessed. */
export function cleanSlots(slots: readonly AvailabilitySlot[] | null | undefined) {
  return (slots ?? [])
    .map((s) => ({ weekday: s.weekday, start: minutes(s.start), end: minutes(s.end) }))
    .filter(
      (s): s is { weekday: AvailabilitySlot["weekday"]; start: number; end: number } =>
        Number.isInteger(s.weekday) &&
        s.weekday >= 0 &&
        s.weekday <= 6 &&
        s.start !== null &&
        s.end !== null &&
        s.start < s.end,
    )
    .sort((a, b) => a.weekday - b.weekday || a.start - b.start);
}

const tag = (locale: "en" | "hi") => (locale === "hi" ? "hi-IN" : "en-IN");

/** 2024-01-01 was a Monday: weekday n (0 = Monday) is 1 + n January 2024. */
export function weekdayName(weekday: number, locale: "en" | "hi", width: "short" | "long") {
  return new Intl.DateTimeFormat(tag(locale), { weekday: width, timeZone: "UTC" }).format(
    new Date(Date.UTC(2024, 0, 1 + weekday)),
  );
}

/** Minutes after midnight (IST wall clock) as "9:00 am"; 24:00 shows as midnight. */
export function timeOfDay(mins: number, locale: "en" | "hi"): string {
  return new Intl.DateTimeFormat(tag(locale), {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2024, 0, 1, 0, mins % (24 * 60))));
}

/**
 * Rows for display: consecutive weekdays with the same hours are merged ("Mon–Fri"). Empty or
 * invalid schedules give no rows, and the profile then shows nothing.
 */
export function availabilityRows(
  availability: Availability | null | undefined,
  locale: "en" | "hi",
  /** Sentences in the page's language: "Monday to Friday", "Saturday and Sunday". */
  words: { range(from: string, to: string): string; pair(a: string, b: string): string },
): AvailabilityRow[] {
  const slots = cleanSlots(availability?.slots);
  const byDay = new Map<number, string>();
  for (const s of slots) {
    const range = `${timeOfDay(s.start, locale)} – ${timeOfDay(s.end, locale)}`;
    byDay.set(s.weekday, byDay.has(s.weekday) ? `${byDay.get(s.weekday)}, ${range}` : range);
  }
  const groups: { from: number; to: number; times: string }[] = [];
  for (let d = 0; d < 7; d++) {
    const times = byDay.get(d);
    if (!times) continue;
    const last = groups[groups.length - 1];
    if (last && last.to === d - 1 && last.times === times) last.to = d;
    else groups.push({ from: d, to: d, times });
  }
  return groups.map(({ from, to, times }) => {
    const s = (d: number) => weekdayName(d, locale, "short");
    const l = (d: number) => weekdayName(d, locale, "long");
    if (from === to) return { days: s(from), daysLong: l(from), times };
    if (to === from + 1)
      return { days: `${s(from)}, ${s(to)}`, daysLong: words.pair(l(from), l(to)), times };
    return { days: `${s(from)}–${s(to)}`, daysLong: words.range(l(from), l(to)), times };
  });
}
