"use client";

import { formatInZone } from "@astro/shared";
import { useLocale, useTranslations } from "next-intl";

/** Localised names for engine ids (messages/{locale}/tools.json, generated from data/astro). */
export function useAstroNames() {
  const t = useTranslations("toolAstro");
  const locale = useLocale();
  const signIds = [
    "aries",
    "taurus",
    "gemini",
    "cancer",
    "leo",
    "virgo",
    "libra",
    "scorpio",
    "sagittarius",
    "capricorn",
    "aquarius",
    "pisces",
  ];
  return {
    graha: (id: string) => (t.has(`graha.${id}`) ? t(`graha.${id}`) : id),
    sign: (id: string) => (t.has(`sign.${id}`) ? t(`sign.${id}`) : id),
    signAt: (index: number) => t(`sign.${signIds[((index % 12) + 12) % 12]}`),
    nakshatra: (id: string) => (t.has(`nakshatra.${id}`) ? t(`nakshatra.${id}`) : id),
    date: (iso: string, tz: string) =>
      formatInZone(iso, tz, locale === "hi" ? "hi-IN" : "en-IN", { dateStyle: "medium" }),
    locale,
  };
}
