import type { ChartLocale, GrahaId } from "./types";

interface Labels {
  grahaShort: Record<GrahaId, string>;
  grahaName: Record<GrahaId, string>;
  signShort: string[];
  signName: string[];
  retro: string;
  /** Sentence end: "." in English, the danda "।" in Hindi. */
  stop: string;
  asc: string;
  ascendant: string;
  house: string;
  none: string;
  northTitle: string;
  southTitle: string;
  rashi: string;
  unknownTime: string;
  moonChart: string;
}

export const CHART_LABELS: Record<ChartLocale, Labels> = {
  en: {
    grahaShort: {
      sun: "Su",
      moon: "Mo",
      mars: "Ma",
      mercury: "Me",
      jupiter: "Ju",
      venus: "Ve",
      saturn: "Sa",
      rahu: "Ra",
      ketu: "Ke",
    },
    grahaName: {
      sun: "Sun",
      moon: "Moon",
      mars: "Mars",
      mercury: "Mercury",
      jupiter: "Jupiter",
      venus: "Venus",
      saturn: "Saturn",
      rahu: "Rahu",
      ketu: "Ketu",
    },
    signShort: ["Ar", "Ta", "Ge", "Cn", "Le", "Vi", "Li", "Sc", "Sg", "Cp", "Aq", "Pi"],
    signName: [
      "Aries",
      "Taurus",
      "Gemini",
      "Cancer",
      "Leo",
      "Virgo",
      "Libra",
      "Scorpio",
      "Sagittarius",
      "Capricorn",
      "Aquarius",
      "Pisces",
    ],
    retro: "(R)",
    stop: ".",
    asc: "Asc",
    ascendant: "Ascendant",
    house: "House",
    none: "empty",
    northTitle: "North Indian birth chart",
    southTitle: "South Indian birth chart",
    rashi: "Rashi chart",
    unknownTime: "Birth time unknown",
    moonChart: "Moon chart: house 1 is the Moon's sign",
  },
  hi: {
    grahaShort: {
      sun: "सू",
      moon: "चं",
      mars: "मं",
      mercury: "बु",
      jupiter: "गु",
      venus: "शु",
      saturn: "श",
      rahu: "रा",
      ketu: "के",
    },
    grahaName: {
      sun: "सूर्य",
      moon: "चन्द्र",
      mars: "मंगल",
      mercury: "बुध",
      jupiter: "गुरु",
      venus: "शुक्र",
      saturn: "शनि",
      rahu: "राहु",
      ketu: "केतु",
    },
    signShort: [
      "मेष",
      "वृष",
      "मिथुन",
      "कर्क",
      "सिंह",
      "कन्या",
      "तुला",
      "वृश्चिक",
      "धनु",
      "मकर",
      "कुंभ",
      "मीन",
    ],
    signName: [
      "मेष",
      "वृषभ",
      "मिथुन",
      "कर्क",
      "सिंह",
      "कन्या",
      "तुला",
      "वृश्चिक",
      "धनु",
      "मकर",
      "कुम्भ",
      "मीन",
    ],
    retro: "(व)",
    stop: "।",
    asc: "लग्न",
    ascendant: "लग्न",
    house: "भाव",
    none: "खाली",
    northTitle: "उत्तर भारतीय जन्म कुंडली",
    southTitle: "दक्षिण भारतीय जन्म कुंडली",
    rashi: "राशि चक्र",
    unknownTime: "जन्म समय अज्ञात",
    moonChart: "चन्द्र कुंडली: पहला भाव चन्द्र की राशि है",
  },
};
