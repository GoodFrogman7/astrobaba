import { AVAILABILITY_LIMITS, type AvailabilitySlot, type Weekday } from "@astro/shared";

/**
 * Weekly schedule helpers (docs/api/portal.md §2.1). Times are "HH:MM" in IST, 15-minute steps,
 * `start < end`, no overlaps on a weekday, at most 21 slots. The server is the authority; these
 * rules are mirrored so the editor can point at a bad slot before saving.
 *
 * A slot may end at "24:00" (midnight at the end of the day) so an overnight shift can be written
 * as two slots, e.g. Monday 22:00–24:00 and Tuesday 00:00–02:00.
 */

export const WEEKDAYS: readonly { value: Weekday; label: string; short: string }[] = [
  { value: 0, label: "Monday", short: "Mon" },
  { value: 1, label: "Tuesday", short: "Tue" },
  { value: 2, label: "Wednesday", short: "Wed" },
  { value: 3, label: "Thursday", short: "Thu" },
  { value: 4, label: "Friday", short: "Fri" },
  { value: 5, label: "Saturday", short: "Sat" },
  { value: 6, label: "Sunday", short: "Sun" },
];

export const DAY_MINUTES = 24 * 60;
const STEP = AVAILABILITY_LIMITS.stepMinutes;
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000; // IST has no daylight saving

/** "HH:MM" → minutes after midnight; "24:00" is the end of the day. Null when malformed. */
export function toMinutes(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min !== 0)) return null;
  return h * 60 + min;
}

export function fromMinutes(total: number): string {
  const t = Math.max(0, Math.min(DAY_MINUTES, Math.round(total)));
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

/** Choices for the time pickers: starts 00:00–23:45, ends 00:15–24:00. */
export function timeOptions(kind: "start" | "end"): string[] {
  const out: string[] = [];
  const first = kind === "start" ? 0 : STEP;
  const last = kind === "start" ? DAY_MINUTES - STEP : DAY_MINUTES;
  for (let t = first; t <= last; t += STEP) out.push(fromMinutes(t));
  return out;
}

export function weekdayLabel(w: number): string {
  return WEEKDAYS[w]?.label ?? "Unknown day";
}

export function formatSlot(s: AvailabilitySlot): string {
  return `${WEEKDAYS[s.weekday]?.short ?? "?"} ${s.start}–${s.end}`;
}

export interface SlotIssue {
  /** Index into the slots array as edited (and as sent to the API). */
  index: number;
  message: string;
}

export interface Validation {
  ok: boolean;
  issues: SlotIssue[];
  /** Set when there are more than the allowed number of slots. */
  tooMany: string | null;
}

function isWeekday(w: unknown): w is Weekday {
  return typeof w === "number" && Number.isInteger(w) && w >= 0 && w <= 6;
}

/** The same checks as the API, reported per slot (the first problem of each slot). */
export function validateSlots(slots: readonly AvailabilitySlot[]): Validation {
  const issues = new Map<number, string>();
  const ranges: { index: number; weekday: number; start: number; end: number }[] = [];
  slots.forEach((s, index) => {
    if (!isWeekday(s.weekday)) return void issues.set(index, "Choose a day.");
    const start = toMinutes(s.start);
    const end = toMinutes(s.end);
    if (start === null || end === null || start >= DAY_MINUTES) {
      return void issues.set(index, "Enter times as HH:MM.");
    }
    if (start % STEP !== 0 || end % STEP !== 0) {
      return void issues.set(index, `Times must be on ${STEP}-minute steps (:00, :15, :30, :45).`);
    }
    if (start >= end) {
      return void issues.set(
        index,
        "The end must be after the start. For an overnight shift, add two slots (until 24:00, then from 00:00 the next day).",
      );
    }
    ranges.push({ index, weekday: s.weekday, start, end });
  });
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const a = ranges[i]!;
      const b = ranges[j]!;
      if (a.weekday === b.weekday && a.start < b.end && b.start < a.end) {
        const msg = (o: typeof a) =>
          `Overlaps ${weekdayLabel(o.weekday)} ${fromMinutes(o.start)}–${fromMinutes(o.end)}.`;
        if (!issues.has(b.index)) issues.set(b.index, msg(a));
        if (!issues.has(a.index)) issues.set(a.index, msg(b));
      }
    }
  }
  const tooMany =
    slots.length > AVAILABILITY_LIMITS.maxSlots
      ? `At most ${AVAILABILITY_LIMITS.maxSlots} slots a week. Remove ${slots.length - AVAILABILITY_LIMITS.maxSlots}.`
      : null;
  const list = [...issues.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, message]) => ({ index, message }));
  return { ok: list.length === 0 && !tooMany, issues: list, tooMany };
}

/* ---------- Editing (pure: each returns a new array) ---------- */

/**
 * A new slot on `weekday` in the first free gap of at least 15 minutes, up to 3 hours long
 * (10:00–13:00 on an empty day). Null when the day is full or the weekly limit is reached.
 */
export function addSlot(
  slots: readonly AvailabilitySlot[],
  weekday: Weekday,
): AvailabilitySlot[] | null {
  if (slots.length >= AVAILABILITY_LIMITS.maxSlots) return null;
  const day = slots
    .filter((s) => s.weekday === weekday)
    .map((s) => ({ start: toMinutes(s.start), end: toMinutes(s.end) }))
    .filter((r): r is { start: number; end: number } => r.start !== null && r.end !== null)
    .sort((a, b) => a.start - b.start);
  if (day.length === 0) return [...slots, { weekday, start: "10:00", end: "13:00" }];
  let cursor = 0;
  const gaps: { start: number; end: number }[] = [];
  for (const r of day) {
    if (r.start > cursor) gaps.push({ start: cursor, end: r.start });
    cursor = Math.max(cursor, r.end);
  }
  if (cursor < DAY_MINUTES) gaps.push({ start: cursor, end: DAY_MINUTES });
  // Prefer a gap later in the day (after the day's first slot) over the small hours.
  const usable = gaps
    .map((g) => ({ start: Math.ceil(g.start / STEP) * STEP, end: Math.floor(g.end / STEP) * STEP }))
    .filter((g) => g.end - g.start >= STEP);
  const gap = usable.find((g) => g.start >= day[0]!.start) ?? usable[0];
  if (!gap) return null;
  const end = Math.min(gap.end, gap.start + 180);
  return [...slots, { weekday, start: fromMinutes(gap.start), end: fromMinutes(end) }];
}

export function removeSlot(slots: readonly AvailabilitySlot[], index: number): AvailabilitySlot[] {
  return slots.filter((_, i) => i !== index);
}

export function updateSlot(
  slots: readonly AvailabilitySlot[],
  index: number,
  patch: Partial<AvailabilitySlot>,
): AvailabilitySlot[] {
  return slots.map((s, i) => (i === index ? { ...s, ...patch } : s));
}

/**
 * Replace the slots of each day in `to` with copies of `from`'s slots. Null when the result
 * would exceed the weekly limit.
 */
export function copyDay(
  slots: readonly AvailabilitySlot[],
  from: Weekday,
  to: readonly Weekday[],
): AvailabilitySlot[] | null {
  const source = slots.filter((s) => s.weekday === from);
  const targets = new Set(to.filter((d) => d !== from));
  const kept = slots.filter((s) => !targets.has(s.weekday));
  const copies = [...targets].flatMap((weekday) => source.map((s) => ({ ...s, weekday })));
  const next = [...kept, ...copies];
  return next.length > AVAILABILITY_LIMITS.maxSlots ? null : next;
}

/** Day-by-day view that keeps each slot's index in the flat array, sorted by start time. */
export function groupByDay(
  slots: readonly AvailabilitySlot[],
): { weekday: Weekday; label: string; entries: { slot: AvailabilitySlot; index: number }[] }[] {
  return WEEKDAYS.map((d) => ({
    weekday: d.value,
    label: d.label,
    entries: slots
      .map((slot, index) => ({ slot, index }))
      .filter((e) => e.slot.weekday === d.value)
      .sort((a, b) => (toMinutes(a.slot.start) ?? 0) - (toMinutes(b.slot.start) ?? 0)),
  }));
}

/** Canonical order (day, then start) for comparing schedules and for display. */
export function sortSlots(slots: readonly AvailabilitySlot[]): AvailabilitySlot[] {
  return [...slots].sort(
    (a, b) =>
      a.weekday - b.weekday ||
      (toMinutes(a.start) ?? 0) - (toMinutes(b.start) ?? 0) ||
      (toMinutes(a.end) ?? 0) - (toMinutes(b.end) ?? 0),
  );
}

export function sameSchedule(a: readonly AvailabilitySlot[], b: readonly AvailabilitySlot[]) {
  if (a.length !== b.length) return false;
  const x = sortSlots(a);
  const y = sortSlots(b);
  return x.every(
    (s, i) => s.weekday === y[i]!.weekday && s.start === y[i]!.start && s.end === y[i]!.end,
  );
}

/* ---------- Now, in IST ---------- */

/** IST weekday (0 = Monday) and minutes after midnight for an instant. */
export function istClock(nowMs: number): { weekday: Weekday; minutes: number } {
  const d = new Date(nowMs + IST_OFFSET_MS);
  const weekday = ((d.getUTCDay() + 6) % 7) as Weekday;
  return { weekday, minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/** The slot running at `nowMs` (IST), if any. Malformed slots are ignored. */
export function activeSlot(
  slots: readonly AvailabilitySlot[],
  nowMs: number,
): AvailabilitySlot | null {
  const { weekday, minutes } = istClock(nowMs);
  for (const s of sortSlots(slots)) {
    if (s.weekday !== weekday) continue;
    const start = toMinutes(s.start);
    const end = toMinutes(s.end);
    if (start !== null && end !== null && start <= minutes && minutes < end) return s;
  }
  return null;
}

/* ---------- API errors ---------- */

/**
 * `422 invalid_slots` names the bad slot by index. The field name is read tolerantly (`index`,
 * `slot_index`, or the first of `indexes`/`errors[].index`). Null when no index is given.
 */
export function invalidSlotIndex(body: unknown, count: number): number | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const candidates: unknown[] = [
    b.index,
    b.slot_index,
    Array.isArray(b.indexes) ? b.indexes[0] : undefined,
    Array.isArray(b.errors) ? (b.errors[0] as { index?: unknown } | undefined)?.index : undefined,
  ];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isInteger(c) && c >= 0 && c < count) return c;
  }
  return null;
}
