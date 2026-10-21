/**
 * Selections over the engine's output for the report. These only pick or join values the engine
 * (or a data/astro table) already gave; nothing here computes a position, period or score.
 */
import type { Span } from "@/lib/almanac/types";
import type { GrahaId } from "@/components/charts";
import type { ReportDasha, ReportKundli } from "./types";

const ms = (iso: string) => Date.parse(iso);

/** The span (tithi, nakshatra, choghadiya, …) running at an instant: start <= t < end. */
export function spanAt<T extends Span>(spans: readonly T[] | undefined, iso: string): T | null {
  const t = ms(iso);
  if (!spans || !Number.isFinite(t)) return null;
  return spans.find((s) => ms(s.start) <= t && t < ms(s.end)) ?? null;
}

export function isAt(span: Span, iso: string): boolean {
  const t = ms(iso);
  return ms(span.start) <= t && t < ms(span.end);
}

/** Current and next mahadasha by the engine's own "as of" instant. */
export function dashaNow(dasha: ReportDasha): {
  asOf: string | null;
  current: number;
  next: number;
} {
  const asOf = dasha.current?.as_of ?? null;
  if (!asOf) return { asOf, current: -1, next: -1 };
  const current = dasha.mahadashas.findIndex((m) => isAt(m, asOf));
  const next = current >= 0 && current + 1 < dasha.mahadashas.length ? current + 1 : -1;
  return { asOf, current, next };
}

export interface HouseRow {
  house: number;
  signIndex: number;
  lord: string;
  /** House where the lord sits, from the engine's graha placements. */
  lordHouse: number | null;
  occupants: GrahaId[];
}

/** Whole-sign houses from the engine, joined with sign lords from data/astro/signs.json. */
export function houseRows(
  kundli: ReportKundli,
  signLordAt: (index: number) => string,
): HouseRow[] | null {
  if (!kundli.houses) return null;
  return kundli.houses.map((h) => {
    const lord = signLordAt(h.sign_index);
    const placed = kundli.grahas.find((g) => g.id === lord);
    return {
      house: h.house,
      signIndex: h.sign_index,
      lord,
      lordHouse: placed?.house ?? null,
      occupants: h.occupants,
    };
  });
}

/** "abcdef12": the first block of a report id, for footers and the cover. */
export function shortRef(id: string): string {
  const clean = id.replace(/[^A-Za-z0-9-]/g, "");
  return (clean.split("-")[0] || clean).slice(0, 12);
}
