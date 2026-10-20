import { CHART_LABELS } from "./labels";
import type { ChartGraha, ChartLocale, KundliChartData } from "./types";

export interface HouseCell {
  house: number; // 1-12, counted from the first sign
  signIndex: number; // 0 = Aries
  grahas: ChartGraha[];
}

export interface ChartLayout {
  /** "lagna": house 1 is the ascendant's sign. "moon": birth time unknown, house 1 is the Moon's sign. */
  mode: "lagna" | "moon";
  firstSign: number;
  houses: HouseCell[];
}

const ORDER = ["sun", "moon", "mars", "mercury", "jupiter", "venus", "saturn", "rahu", "ketu"];

/** Whole-sign houses from the ascendant, or from the Moon when the birth time is unknown. */
export function chartLayout(data: KundliChartData): ChartLayout {
  const moon = data.grahas.find((g) => g.id === "moon");
  const mode = data.ascendant ? "lagna" : "moon";
  const firstSign = data.ascendant?.sign_index ?? moon?.sign_index ?? 0;
  const grahas = [...data.grahas].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  const houses = Array.from({ length: 12 }, (_, i) => {
    const signIndex = (firstSign + i) % 12;
    return { house: i + 1, signIndex, grahas: grahas.filter((g) => g.sign_index === signIndex) };
  });
  return { mode, firstSign, houses };
}

/** "Su 16°", "Sa 16°(R)". Rahu and Ketu always move backwards, so they carry no mark. */
export function grahaLabel(g: ChartGraha, locale: ChartLocale): string {
  const l = CHART_LABELS[locale];
  const retro = g.retrograde && g.id !== "rahu" && g.id !== "ketu" ? l.retro : "";
  return `${l.grahaShort[g.id]} ${Math.floor(g.degree_in_sign)}°${retro}`;
}

/** Plain-text summary used for aria-label and the screen-reader list. */
export function houseSummaries(layout: ChartLayout, locale: ChartLocale): string[] {
  const l = CHART_LABELS[locale];
  return layout.houses.map((h) => {
    const who = h.grahas.length
      ? h.grahas
          .map(
            (g) =>
              `${l.grahaName[g.id]} ${Math.floor(g.degree_in_sign)}°${g.retrograde && g.id !== "rahu" && g.id !== "ketu" ? ` ${l.retro}` : ""}`,
          )
          .join(", ")
      : l.none;
    return `${l.house} ${h.house} (${l.signName[h.signIndex]}): ${who}`;
  });
}

export function chartSummary(layout: ChartLayout, locale: ChartLocale, title: string): string {
  const l = CHART_LABELS[locale];
  const head =
    layout.mode === "lagna"
      ? `${title}${l.stop} ${l.ascendant}: ${l.signName[layout.firstSign]}${l.stop}`
      : `${title}${l.stop} ${l.unknownTime}${l.stop} ${l.moonChart}${l.stop}`;
  return `${head} ${houseSummaries(layout, locale).join("; ")}${l.stop}`;
}
