/**
 * RenderData for the printable reports (docs/api/revenue.md §2.3). The snapshot holds the astro
 * engine's raw responses (services/astro): /v1/kundli, /v1/dasha, /v1/doshas, /v1/numerology,
 * /v1/panchang (for the date of birth at the birth place), /v1/match and /v1/meta. The report
 * pages only read and format these values; they never compute astrology of their own.
 */
import type { ReportLanguage, ReportSku } from "@astro/shared";
import type { Panchang as AlmanacPanchang, NakshatraSpan, TithiSpan } from "@/lib/almanac/types";
import type { Dasha, Doshas, Kundli, Match, Numerology, Placement } from "@/lib/tools/types";

export interface ReportKundli extends Kundli {
  birth: Kundli["birth"] & { julian_day_ut?: number };
  settings: Kundli["settings"] & {
    zodiac?: string;
    positions?: string;
    engine?: string;
    engine_version?: string;
  };
}

export interface ReportDasha extends Dasha {
  system?: string;
  year_days?: number;
}

export interface ReportDoshas extends Doshas {
  sade_sati: Doshas["sade_sati"] & { moon_sign_index?: number; window_years?: number };
}

export interface ReportPanchang extends AlmanacPanchang {
  tithi_at_sunrise?: TithiSpan;
  nakshatra_at_sunrise?: NakshatraSpan;
  sun_at_sunrise?: Placement;
  moon_at_sunrise?: Placement;
  settings: {
    engine?: string;
    engine_version?: string;
    ayanamsha?: string;
    sunrise_convention?: string;
    day?: string;
    tables_review_status?: Record<string, string>;
  };
}

export interface EngineMeta {
  version: string;
  ephemeris_backend: string;
  ephemeris_version: string;
  default_ayanamsha?: string;
  default_node?: string;
  house_system: string;
  time_contract?: string;
  tables_review_status: Record<string, string>;
  source: string;
  license: string;
}

export interface SnapshotEntry {
  /** The saved kundli's label (usually the person's name). */
  label: string;
  birth: {
    date: string;
    time: string | null;
    place: { name: string; lat: number; lon: number; tz: string };
  };
  kundli: ReportKundli;
  dasha: ReportDasha;
  doshas: ReportDoshas;
  numerology: Numerology | null;
  panchang: ReportPanchang;
}

export interface RenderData {
  report: {
    id: string;
    sku: ReportSku;
    language: ReportLanguage;
    created_at: string;
    engine_version: string;
  };
  snapshot: {
    kundlis: SnapshotEntry[];
    match: Match | null;
    meta: EngineMeta;
  };
}

/** Structural check of untrusted JSON before rendering; returns null when it does not fit. */
export function asRenderData(value: unknown): RenderData | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<RenderData>;
  const r = v.report;
  const s = v.snapshot;
  if (!r || !s || typeof r.id !== "string" || typeof r.created_at !== "string") return null;
  if (r.language !== "en" && r.language !== "hi") return null;
  if (r.sku !== "kundli_report" && r.sku !== "matching_report") return null;
  if (!Array.isArray(s.kundlis) || !s.meta) return null;
  const need = r.sku === "matching_report" ? 2 : 1;
  if (s.kundlis.length < need) return null;
  if (r.sku === "matching_report" && !s.match) return null;
  for (const k of s.kundlis) {
    if (!k?.kundli?.grahas || !k.dasha?.mahadashas || !k.doshas || !k.panchang || !k.birth?.place)
      return null;
  }
  return value as RenderData;
}
