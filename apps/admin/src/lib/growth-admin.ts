/**
 * Launch and growth screens in the admin console (docs/api/growth.md, Phase 8): pure helpers for
 * the funnel, supply, content calendar and launch readiness pages. Names come from the static
 * data tables (signs, taxonomy) and core hours from data/growth/targets.json; nothing is typed
 * in by hand here.
 */
import {
  CONTENT_KINDS,
  CONTENT_LOCALES,
  CONTENT_STATUSES,
  INVITE_STATUSES,
  READINESS_CHECKS,
  TRAFFIC_SOURCES,
  istToday,
  type AlmanacDate,
  type ContentItem,
  type CoverageRow,
  type FunnelStep,
  type FunnelStepKey,
  type InviteStatus,
  type ReadinessCheck,
  type TrafficSource,
} from "@astro/shared";
import signsFile from "../../../../data/astro/signs.json" with { type: "json" };
import targetsFile from "../../../../data/growth/targets.json" with { type: "json" };
import taxonomyFile from "../../../../data/marketplace/taxonomy.json" with { type: "json" };

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/* ---------- IST calendar dates (YYYY-MM-DD strings, no time zone drift) ---------- */

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 3600 * 1000;

/** A real calendar date in YYYY-MM-DD form. */
export function isDate(v: string): boolean {
  if (!DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** The Monday on or before a calendar date (ISO weeks, as the API's weekly cohorts). */
export function mondayOf(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}

/** "Wed, 5 Nov 2026" for a calendar date (the date itself, not an instant). */
export function formatDay(date: string): string {
  if (!isDate(date)) return date;
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(`${date}T00:00:00Z`));
}

/** Funnel default: the last 28 full IST days (yesterday and the 27 days before it). */
export function defaultFunnelRange(now: Date = new Date()): { from: string; to: string } {
  const to = addDays(istToday(now), -1);
  return { from: addDays(to, -27), to };
}

/** Content calendar default: this IST week (from Monday) and the next 5 weeks. */
export function defaultContentRange(now: Date = new Date()): { from: string; to: string } {
  const from = mondayOf(istToday(now));
  return { from, to: addDays(from, 6 * 7 - 1) };
}

/* ---------- Funnel ---------- */

export const FUNNEL_MAX_DAYS = 92;
export const LOCALE_FILTERS = ["all", "en", "hi"] as const;
export type LocaleFilter = (typeof LOCALE_FILTERS)[number];
export const SOURCE_FILTERS = ["all", ...TRAFFIC_SOURCES] as const;
export type SourceFilter = "all" | TrafficSource;

export interface FunnelQuery {
  from: string;
  to: string;
  window_days: number;
  locale: LocaleFilter;
  source: SourceFilter;
}

/**
 * Read the funnel filters from the page's query string. Anything invalid falls back to its
 * default, and the reason is returned so the page can say why.
 */
export function parseFunnelQuery(
  sp: Record<string, string | string[] | undefined>,
  now: Date = new Date(),
): { query: FunnelQuery; problems: string[] } {
  const one = (k: string) => {
    const v = sp[k];
    return (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
  };
  const problems: string[] = [];
  const def = defaultFunnelRange(now);
  let from = one("from") || def.from;
  let to = one("to") || def.to;
  if (!isDate(from) || !isDate(to)) {
    problems.push("Dates must be real days in YYYY-MM-DD form; showing the default range.");
    ({ from, to } = def);
  } else if (from > to) {
    problems.push("The start date is after the end date; showing the default range.");
    ({ from, to } = def);
  } else if (daysBetween(from, to) > FUNNEL_MAX_DAYS) {
    problems.push(`The range can be at most ${FUNNEL_MAX_DAYS} days; showing the default range.`);
    ({ from, to } = def);
  }
  let window_days = 30;
  const w = one("window_days");
  if (w) {
    const n = Number(w);
    if (Number.isInteger(n) && n >= 1 && n <= 90) window_days = n;
    else problems.push("The window must be a whole number of days from 1 to 90; using 30.");
  }
  const loc = one("locale");
  const locale = (LOCALE_FILTERS as readonly string[]).includes(loc)
    ? (loc as LocaleFilter)
    : "all";
  const src = one("source");
  const source = (SOURCE_FILTERS as readonly string[]).includes(src)
    ? (src as SourceFilter)
    : "all";
  return { query: { from, to, window_days, locale, source }, problems };
}

export function funnelApiPath(q: FunnelQuery): string {
  const p = new URLSearchParams({ from: q.from, to: q.to, window_days: String(q.window_days) });
  if (q.locale !== "all") p.set("locale", q.locale);
  if (q.source !== "all") p.set("source", q.source);
  return `/v1/admin/growth/funnel?${p}`;
}

export const STEP_LABEL: Record<FunnelStepKey, string> = {
  visit: "Visit",
  tool_use: "Used a tool",
  otp: "Verified OTP",
  free_session: "Started free session",
  first_recharge: "First recharge",
  repeat: "Repeat recharge",
};

export type TargetClass = "below" | "within" | "above";

/**
 * Compare a step's conversion rate with its target range. Null when there is no rate or no
 * target; a target with no upper bound (`high: null`) is met at or above `low`.
 */
export function classifyRate(
  rate: number | null,
  target: FunnelStep["target"],
): TargetClass | null {
  if (rate === null || !target) return null;
  if (rate < target.low) return "below";
  if (target.high !== null && rate > target.high) return "above";
  return "within";
}

export const TARGET_CLASS_LABEL: Record<TargetClass, string> = {
  below: "Below target",
  within: "Within target",
  above: "Above target",
};

/** A fraction as a percentage with at most one decimal: 0.08 → "8%", 0.1234 → "12.3%". */
export function percent(fraction: number): string {
  return `${Number((fraction * 100).toFixed(1))}%`;
}

/** "—" for a null rate (first step, or the previous step was 0). */
export function formatRate(rate: number | null): string {
  return rate === null ? "—" : percent(rate);
}

export function formatTarget(target: FunnelStep["target"]): string {
  if (!target) return "—";
  if (target.high === null) return `≥ ${percent(target.low)}`;
  return `${percent(target.low)}–${percent(target.high)}`;
}

/** Bar width (0–100) relative to the first step; 0 when the first step is 0. */
export function barWidth(count: number, first: number): number {
  if (first <= 0 || count <= 0) return 0;
  return Math.min(100, (count / first) * 100);
}

/* ---------- Supply ---------- */

export const PIPELINE_STATUSES = [
  "applied",
  "kyc_submitted",
  "interview",
  "probation",
  "approved",
  "suspended",
  "rejected",
] as const;

export const PIPELINE_LABEL: Record<(typeof PIPELINE_STATUSES)[number], string> = {
  applied: "Applied",
  kyc_submitted: "Documents in",
  interview: "Interview",
  probation: "Probation",
  approved: "Approved",
  suspended: "Suspended",
  rejected: "Rejected",
};

export const VERIFICATION_STEPS = ["identity", "qualification", "interview", "probation"] as const;
export const VERIFICATION_LABEL: Record<(typeof VERIFICATION_STEPS)[number], string> = {
  identity: "Identity",
  qualification: "Qualification",
  interview: "Interview",
  probation: "Probation",
};

/** Where the live count stands against the target range. */
export function supplyStatus(live: number, target: { min: number; max: number }): string {
  if (live < target.min) return `Below minimum (${target.min - live} short)`;
  if (live > target.max) return "Above target range";
  return "Within target range";
}

export function coverageStatus(row: CoverageRow): string {
  if (row.target_min <= 0) return "No minimum set";
  if (row.live >= row.target_min) return "Meets minimum";
  return `Short by ${row.target_min - row.live}`;
}

const LANGUAGE_NAMES = new Map(taxonomyFile.languages.map((l) => [l.id, l.en]));
const SKILL_NAMES = new Map(taxonomyFile.skills.map((s) => [s.id, s.en]));
export const languageName = (id: string) => LANGUAGE_NAMES.get(id) ?? id;
export const skillName = (id: string) => SKILL_NAMES.get(id) ?? id;

export const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

/**
 * Core hours from data/growth/targets.json (`weekdays` 0 = Monday, hours `from_hour` up to but
 * not including `to_hour`, IST). Only used to mark cells; the uncovered count comes from the API.
 */
export function isCoreHour(weekday: number, hour: number): boolean {
  const c = targetsFile.supply.core_hours;
  return c.weekdays.includes(weekday) && hour >= c.from_hour && hour < c.to_hour;
}

/** The schedule grid if it is 7 rows of 24 non-negative numbers, else null. */
export function scheduleGrid(hours: unknown): number[][] | null {
  if (!Array.isArray(hours) || hours.length !== 7) return null;
  for (const row of hours) {
    if (!Array.isArray(row) || row.length !== 24) return null;
    if (!row.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) return null;
  }
  return hours as number[][];
}

/* ---------- Invites ---------- */

export const INVITE_NOTE_MAX = 200;
export const INVITE_STATUS_LABEL: Record<InviteStatus, string> = {
  open: "Open",
  used: "Used",
  expired: "Expired",
  revoked: "Revoked",
};

export function inviteStatusFilter(input: string | undefined): InviteStatus | null {
  return (INVITE_STATUSES as readonly string[]).includes(input ?? "")
    ? (input as InviteStatus)
    : null;
}

export function parseInviteForm(fields: {
  note: string;
  expires_days: string;
}): Parsed<{ note?: string; expires_days: number }> {
  const note = fields.note.trim();
  if (note.length > INVITE_NOTE_MAX) {
    return { ok: false, error: `Keep the note to ${INVITE_NOTE_MAX} characters or fewer.` };
  }
  const raw = fields.expires_days.trim();
  const days = raw === "" ? 14 : Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 60) {
    return { ok: false, error: "Expiry must be a whole number of days from 1 to 60." };
  }
  return { ok: true, value: note ? { note, expires_days: days } : { expires_days: days } };
}

export function inviteErrorText(code: string): string | undefined {
  switch (code) {
    case "invite_used":
      return "This invite has already been used, so it cannot be revoked.";
    case "not_found":
      return "This invite no longer exists.";
    default:
      return undefined;
  }
}

/* ---------- Content calendar ---------- */

export type ContentKind = (typeof CONTENT_KINDS)[number];
export type ContentStatus = (typeof CONTENT_STATUSES)[number];
export type ContentLocale = (typeof CONTENT_LOCALES)[number];

export const CONTENT_KIND_LABEL: Record<ContentKind, string> = {
  article: "Article",
  horoscope: "Horoscope",
  tool_page: "Tool page",
  social: "Social post",
  video: "Video",
  other: "Other",
};
export const CONTENT_STATUS_LABEL: Record<ContentStatus, string> = {
  idea: "Idea",
  drafting: "Drafting",
  review: "In review",
  scheduled: "Scheduled",
  published: "Published",
};
export const CONTENT_LOCALE_LABEL: Record<ContentLocale, string> = {
  en: "English",
  hi: "Hindi",
  both: "English and Hindi",
};

export const CONTENT_TITLE_MAX = 160;
export const CONTENT_NOTES_MAX = 1000;

export function contentStatusFilter(v: string | undefined): ContentStatus | null {
  return (CONTENT_STATUSES as readonly string[]).includes(v ?? "") ? (v as ContentStatus) : null;
}
export function contentKindFilter(v: string | undefined): ContentKind | null {
  return (CONTENT_KINDS as readonly string[]).includes(v ?? "") ? (v as ContentKind) : null;
}

/** A site path ("/learn/x", not "//host") or an absolute https URL. */
export function isContentUrl(v: string): boolean {
  if (/\s/.test(v)) return false;
  if (v.startsWith("/")) return !v.startsWith("//") && !v.startsWith("/\\");
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.hostname !== "";
  } catch {
    return false;
  }
}

export interface ContentBody {
  title: string;
  kind: ContentKind;
  locale: ContentLocale;
  status: ContentStatus;
  due_date: string | null;
  url: string | null;
  notes: string | null;
}

export interface ContentFields {
  title: string;
  kind: string;
  locale: string;
  status: string;
  due_date: string;
  url: string;
  notes: string;
}

/** Contract validation (growth.md §4.1), used by the form before submitting and by the action. */
export function parseContentForm(f: ContentFields): Parsed<ContentBody> {
  const title = f.title.trim();
  if (title.length < 1) return { ok: false, error: "Add a title." };
  if (title.length > CONTENT_TITLE_MAX) {
    return { ok: false, error: `Keep the title to ${CONTENT_TITLE_MAX} characters or fewer.` };
  }
  if (!(CONTENT_KINDS as readonly string[]).includes(f.kind)) {
    return { ok: false, error: "Choose a kind." };
  }
  if (!(CONTENT_LOCALES as readonly string[]).includes(f.locale)) {
    return { ok: false, error: "Choose a language." };
  }
  if (!(CONTENT_STATUSES as readonly string[]).includes(f.status)) {
    return { ok: false, error: "Choose a status." };
  }
  const due = f.due_date.trim();
  if (due && !isDate(due)) return { ok: false, error: "The due date is not a real day." };
  const url = f.url.trim();
  if (url && !isContentUrl(url)) {
    return {
      ok: false,
      error: "The URL must be a site path starting with / (e.g. /learn/saturn) or an https:// URL.",
    };
  }
  if (f.status === "published" && !url) {
    return { ok: false, error: "A published item needs its URL." };
  }
  const notes = f.notes.trim();
  if (notes.length > CONTENT_NOTES_MAX) {
    return { ok: false, error: `Keep the notes to ${CONTENT_NOTES_MAX} characters or fewer.` };
  }
  return {
    ok: true,
    value: {
      title,
      kind: f.kind as ContentKind,
      locale: f.locale as ContentLocale,
      status: f.status as ContentStatus,
      due_date: due || null,
      url: url || null,
      notes: notes || null,
    },
  };
}

type Query = Record<string, string | string[] | undefined>;
const first = (sp: Query, k: string) => {
  const v = sp[k];
  return ((Array.isArray(v) ? v[0] : v) ?? "").trim();
};

/**
 * Calendar filters from the query string; invalid dates fall back to this week + the next 5
 * (IST). `new_date`/`new_title` prefill the create form ("Plan content for this date").
 */
export function parseContentQuery(sp: Query, now: Date = new Date()) {
  const def = defaultContentRange(now);
  let from = first(sp, "from") || def.from;
  let to = first(sp, "to") || def.to;
  let problem: string | null = null;
  if (!isDate(from) || !isDate(to) || from > to) {
    problem = "Those dates are not a valid range; showing this week and the next 5.";
    ({ from, to } = def);
  }
  const newDate = first(sp, "new_date");
  return {
    from,
    to,
    status: contentStatusFilter(first(sp, "status")),
    kind: contentKindFilter(first(sp, "kind")),
    problem,
    prefill: {
      due_date: isDate(newDate) ? newDate : "",
      title: first(sp, "new_title").slice(0, CONTENT_TITLE_MAX),
    },
  };
}

/** Items grouped by the Monday of their due week, in date order; undated items last. */
export function groupByWeek(items: ContentItem[]): { week: string | null; items: ContentItem[] }[] {
  const groups = new Map<string | null, ContentItem[]>();
  for (const it of items) {
    const key = it.due_date && isDate(it.due_date) ? mondayOf(it.due_date) : null;
    const list = groups.get(key) ?? [];
    list.push(it);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
    .map(([week, list]) => ({ week, items: list }));
}

/* ---------- Dates to plan around ---------- */

const SIGN_NAMES = new Map(signsFile.signs.map((s) => [s.id, s.en]));

const TITHI_AT_SUNRISE = "tithi at sunrise, New Delhi";

export function almanacLabel(d: AlmanacDate): string {
  switch (d.kind) {
    case "purnima":
      return `Purnima (${TITHI_AT_SUNRISE})`;
    case "amavasya":
      return `Amavasya (${TITHI_AT_SUNRISE})`;
    case "ekadashi":
      return `Ekadashi (${TITHI_AT_SUNRISE})`;
    case "sun_sign_change": {
      const name = d.sign ? SIGN_NAMES.get(d.sign) : undefined;
      return name ? `Sun enters ${name} (sidereal)` : "Sun enters a new sign (sidereal)";
    }
    default:
      return String((d as { kind: unknown }).kind);
  }
}

/** Default title for a content item planned around a date. */
export function almanacTitle(d: AlmanacDate): string {
  const short = d.kind === "sun_sign_change" ? almanacLabel(d).replace(" (sidereal)", "") : null;
  const name = short ?? almanacLabel(d).split(" (")[0];
  return `${name}: ${d.date}`.slice(0, CONTENT_TITLE_MAX);
}

/* ---------- Launch readiness ---------- */

export const READINESS_LABEL: Record<(typeof READINESS_CHECKS)[number], string> = {
  legal_approved: "Legal policies approved",
  helplines_verified: "Helplines verified by the founder",
  jyotish_tables_reviewed: "Jyotish tables reviewed",
  supply_live: "Enough live astrologers",
  supply_languages: "Language coverage",
  horoscopes_today: "Today's horoscopes published",
  payments_live: "Live payments (Razorpay)",
  sms_live: "Live SMS provider",
  email_live: "Live email provider",
  document_storage: "KYC document storage (S3)",
  reconciliation_recent: "Recent reconciliation with zero drift",
  jobs_healthy: "Background jobs healthy",
  analytics_flowing: "Analytics events arriving",
  voice_ready: "Voice calls ready",
  ai_ready: "AI assistant ready",
};

export function readinessLabel(id: string): string {
  return (READINESS_LABEL as Record<string, string>)[id] ?? id.replace(/_/g, " ");
}

const STATUS_ORDER: Record<ReadinessCheck["status"], number> = { fail: 0, warn: 1, pass: 2 };

/** Fail first, then warn, then pass; within a status, the contract's order. */
export function sortChecks(checks: ReadinessCheck[]): ReadinessCheck[] {
  const pos = (id: string) => {
    const i = (READINESS_CHECKS as readonly string[]).indexOf(id);
    return i === -1 ? READINESS_CHECKS.length : i;
  };
  return [...checks].sort(
    (a, b) =>
      (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3) || pos(a.id) - pos(b.id),
  );
}

export function readinessTotals(
  checks: ReadinessCheck[],
): Record<"pass" | "warn" | "fail", number> {
  const t = { pass: 0, warn: 0, fail: 0 };
  for (const c of checks) if (c.status in t) t[c.status] += 1;
  return t;
}
