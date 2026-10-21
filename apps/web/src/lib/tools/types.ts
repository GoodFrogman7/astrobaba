/** Engine response shapes used by the tools (subsets of services/astro responses). */
import type { GrahaId } from "@/components/charts";

export interface Placement {
  longitude: number;
  sign: string;
  sign_index: number;
  sign_lord: string;
  degree_in_sign: number;
  dms_in_sign: string;
  nakshatra: string;
  nakshatra_index: number;
  nakshatra_lord: string;
  pada: number;
}

export interface Graha extends Placement {
  id: GrahaId;
  retrograde: boolean;
  house?: number;
}

export interface BirthEcho {
  utc: string;
  local: string;
  tz: string;
  utc_offset: string;
  unknown_time: boolean;
}

export interface Kundli {
  birth: BirthEcho;
  settings: { ayanamsha: string; ayanamsha_deg: number; node: string; house_system: string };
  ascendant: Placement | null;
  grahas: Graha[];
  houses: { house: number; sign_index: number; occupants: GrahaId[] }[] | null;
  moon_range: {
    start: Placement & { at: string };
    end: Placement & { at: string };
    sign_changes: boolean;
    nakshatra_changes: boolean;
  } | null;
  flags: string[];
}

export interface Period {
  lord: string;
  start: string;
  end: string;
  years: number;
}

export interface Dasha {
  balance_at_birth: { lord: string; years: number };
  moon_nakshatra: string;
  mahadashas: (Period & { antardashas: Period[] })[];
  current: { as_of: string; mahadasha: string; antardasha: string | null } | null;
  flags: string[];
}

export interface Doshas {
  flags: string[];
  mangal: {
    present: boolean;
    from: string[];
    mars_house_from: { moon: number | null; lagna: number | null };
    rule: string;
    houses_checked: number[];
  };
  kaal_sarp: { present: boolean; direction: string | null; type: string | null; rule: string };
  sade_sati: {
    active: boolean;
    current_phase: { phase: string; saturn_sign_index: number; start: string; end: string } | null;
    cycles: {
      start: string;
      end: string;
      phases: { phase: string; saturn_sign_index: number; start: string; end: string }[];
    }[];
    rule: string;
  };
  tables_review_status: string;
}

export interface NumberResult {
  number: number;
  steps: string;
  planet: string;
}

export interface Numerology {
  mulank: NumberResult | null;
  bhagyank: NumberResult | null;
  name_number: {
    compound: number;
    number: number;
    letters: { letter: string; value: number }[];
    planet: string;
  } | null;
  review_status: string;
}

export interface Koota {
  koota: string;
  points: number;
  max: number;
  detail: Record<string, unknown>;
}

export interface Match {
  kootas: Koota[];
  total: number;
  max: number;
  doshas: { nadi: boolean; bhakoot: boolean };
  tables_review_status: string;
  groom: { moon: Placement; flags: string[]; mangal_dosha: Doshas["mangal"] };
  bride: { moon: Placement; flags: string[]; mangal_dosha: Doshas["mangal"] };
}

/** What the forms submit. Mirrors the engine's Birth model. */
export interface BirthInput {
  name?: string;
  date: string;
  time: string | null;
  place: { lat: number; lon: number; tz: string; label?: string; city_id?: number };
  fold?: 0 | 1;
}

export type ActionResult<T> = { ok: true; data: T } | { ok: false; code: string; message?: string };
