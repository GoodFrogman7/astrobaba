import grahasFile from "../../../../../data/astro/grahas.json" with { type: "json" };
import signsFile from "../../../../../data/astro/signs.json" with { type: "json" };
import weekdaysFile from "../../../../../data/astro/weekdays.json" with { type: "json" };

/** Names come from the engine's static tables (data/astro), never retyped here. */
export type Loc = "en" | "hi";

export const SIGNS = signsFile.signs.map((s) => ({
  id: s.id,
  en: s.en,
  hi: s.hi,
  sa: s.sa,
  lord: s.lord,
}));
export type SignId = (typeof SIGNS)[number]["id"];
export const SIGN_IDS = SIGNS.map((s) => s.id);

export function signName(id: string, locale: Loc): string {
  const s = SIGNS.find((x) => x.id === id);
  return s ? s[locale] : id;
}

export function grahaName(id: string, locale: Loc): string {
  const g = grahasFile.grahas.find((x) => x.id === id);
  return g ? g[locale] : id;
}

export function weekdayName(id: string, locale: Loc): string {
  const d = weekdaysFile.weekdays.find((x) => x.id === id);
  return d ? d[locale] : id;
}

export const PERIODS = ["daily", "weekly", "monthly"] as const;
export type Period = (typeof PERIODS)[number];
export const AREAS = ["overall", "love", "career", "money", "health"] as const;
export type Area = (typeof AREAS)[number];

const HI_ORDINALS = [
  "पहले",
  "दूसरे",
  "तीसरे",
  "चौथे",
  "पाँचवें",
  "छठे",
  "सातवें",
  "आठवें",
  "नौवें",
  "दसवें",
  "ग्यारहवें",
  "बारहवें",
];

export function houseOrdinal(n: number, locale: Loc): string {
  if (locale === "hi") return HI_ORDINALS[n - 1] ?? String(n);
  const suffix =
    n % 10 === 1 && n !== 11
      ? "st"
      : n % 10 === 2 && n !== 12
        ? "nd"
        : n % 10 === 3 && n !== 13
          ? "rd"
          : "th";
  return `${n}${suffix}`;
}
