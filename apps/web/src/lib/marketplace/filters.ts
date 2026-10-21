import { GENDER_IDS, LANGUAGE_IDS, SKILL_IDS, TIER_IDS } from "./taxonomy";
import type { Sort } from "./types";

/**
 * Directory filters live in the URL query so the page is server-rendered and the GET form works
 * without JavaScript. Prices are whole rupees per minute in the URL and paise in API calls.
 * Anything invalid is dropped rather than passed through.
 */
export const SORTS: Sort[] = ["recommended", "price_asc", "price_desc", "experience", "rating"];
const MAX_RUPEES = 100_000;
const MAX_MULTI = 5;

export interface Filters {
  skills: string[];
  languages: string[];
  gender: string | null;
  tier: string | null;
  minRupees: number | null;
  maxRupees: number | null;
  online: boolean;
  sort: Sort;
}

export type Query = Record<string, string | string[] | undefined>;

const many = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];
const one = (v: string | string[] | undefined): string | undefined => many(v)[0];

function pick(values: string[], allowed: string[]): string[] {
  return [...new Set(values.filter((v) => allowed.includes(v)))].slice(0, MAX_MULTI);
}

function rupees(v: string | undefined): number | null {
  if (v === undefined || !/^\d{1,6}$/.test(v.trim())) return null;
  const n = Number(v);
  return n >= 0 && n <= MAX_RUPEES ? n : null;
}

export function parseFilters(q: Query): Filters {
  let minRupees = rupees(one(q.min_price));
  let maxRupees = rupees(one(q.max_price));
  if (minRupees !== null && maxRupees !== null && minRupees > maxRupees)
    [minRupees, maxRupees] = [maxRupees, minRupees];
  const g = one(q.gender);
  const t = one(q.tier);
  const s = one(q.sort) as Sort | undefined;
  return {
    skills: pick(many(q.skill), SKILL_IDS),
    languages: pick(many(q.language), LANGUAGE_IDS),
    gender: g && GENDER_IDS.includes(g) ? g : null,
    tier: t && TIER_IDS.includes(t) ? t : null,
    minRupees,
    maxRupees,
    online: ["1", "true", "on"].includes(one(q.online) ?? ""),
    sort: s && SORTS.includes(s) ? s : "recommended",
  };
}

export function parseCursor(q: Query, key = "cursor"): string | null {
  const c = one(q[key]);
  return c && /^[A-Za-z0-9_\-=.~]{1,300}$/.test(c) ? c : null;
}

/** True when the visitor narrowed the list (such URLs are noindex, canonical /astrologers). */
export function hasFilters(f: Filters): boolean {
  return (
    f.skills.length > 0 ||
    f.languages.length > 0 ||
    f.gender !== null ||
    f.tier !== null ||
    f.minRupees !== null ||
    f.maxRupees !== null ||
    f.online ||
    f.sort !== "recommended"
  );
}

/** Query string for GET /v1/astrologers. */
export function toApiQuery(f: Filters, cursor: string | null, limit = 20): URLSearchParams {
  const p = new URLSearchParams();
  for (const s of f.skills) p.append("skill", s);
  for (const l of f.languages) p.append("language", l);
  if (f.gender) p.set("gender", f.gender);
  if (f.tier) p.set("tier", f.tier);
  if (f.minRupees !== null) p.set("min_price", String(f.minRupees * 100));
  if (f.maxRupees !== null) p.set("max_price", String(f.maxRupees * 100));
  if (f.online) p.set("online", "true");
  p.set("sort", f.sort);
  if (cursor) p.set("cursor", cursor);
  p.set("limit", String(limit));
  return p;
}

/** Query string for links on the directory page (only non-default values). */
export function toPageQuery(f: Filters, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  for (const s of f.skills) p.append("skill", s);
  for (const l of f.languages) p.append("language", l);
  if (f.gender) p.set("gender", f.gender);
  if (f.tier) p.set("tier", f.tier);
  if (f.minRupees !== null) p.set("min_price", String(f.minRupees));
  if (f.maxRupees !== null) p.set("max_price", String(f.maxRupees));
  if (f.online) p.set("online", "1");
  if (f.sort !== "recommended") p.set("sort", f.sort);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
}

export const EMPTY_FILTERS: Filters = parseFilters({});
