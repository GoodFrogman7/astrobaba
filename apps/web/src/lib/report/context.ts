/**
 * Everything a report section needs to turn engine values into text: translators, table names
 * and formatters. Built once per report from its language. No React and no request state, so the
 * same output comes out on the server, in tests and on any machine, whatever its time zone.
 */
import { formatInZone, IST, type Locale } from "@astro/shared";
import { createTranslator } from "next-intl";
import nakshatrasFile from "../../../../../data/astro/nakshatras.json" with { type: "json" };
import enAlmanac from "../../../messages/en/almanac.json" with { type: "json" };
import enReport from "../../../messages/en/report.json" with { type: "json" };
import enTools from "../../../messages/en/tools.json" with { type: "json" };
import hiAlmanac from "../../../messages/hi/almanac.json" with { type: "json" };
import hiReport from "../../../messages/hi/report.json" with { type: "json" };
import hiTools from "../../../messages/hi/tools.json" with { type: "json" };
import { formatClock, formatClockOnDay, formatIstDate } from "@/lib/almanac/dates";
import { grahaName, SIGNS, signName } from "@/lib/almanac/names";

const MESSAGES = {
  en: { ...enReport, ...enTools, ...enAlmanac },
  hi: { ...hiReport, ...hiTools, ...hiAlmanac },
} as const;
type Messages = typeof MESSAGES.en;

export type Lang = Locale;

export interface NakshatraRow {
  id: string;
  en: string;
  hi: string;
  lord: string;
  gana: string;
  nadi: string;
  yoni: { animal: string; gender: string };
}
const NAKSHATRAS = nakshatrasFile.nakshatras as NakshatraRow[];

function translators(lang: Lang) {
  const messages = MESSAGES[lang] as Messages;
  const base = { locale: lang, messages, timeZone: IST } as const;
  return {
    /** Report copy (messages/{lang}/report.json). */
    t: createTranslator({ ...base, namespace: "printReport" }),
    /** Result wording shared with the free tools, so the report says exactly what the site says. */
    tr: createTranslator({ ...base, namespace: "toolsUi.result" }),
    tm: createTranslator({ ...base, namespace: "toolsUi.match" }),
    tf: createTranslator({ ...base, namespace: "toolsUi.form" }),
    /** Panchang wording shared with the almanac pages. */
    tp: createTranslator({ ...base, namespace: "almanac.panchang" }),
  };
}

const intlLocale = (lang: Lang) => (lang === "hi" ? "hi-IN" : "en-IN");

export function reportContext(lang: Lang) {
  const tx = translators(lang);
  const attrs = MESSAGES[lang].printReport.attr as Record<string, Record<string, string>>;
  const loc = intlLocale(lang);

  return {
    lang,
    ...tx,
    /** Paragraph lists ("How to read this" and similar) from report.json. */
    paras: (key: string): string[] => tx.t.raw(key as never) as string[],

    graha: (id: string) => grahaName(id, lang),
    sign: (id: string) => signName(id, lang),
    signAt: (index: number) => SIGNS[((index % 12) + 12) % 12]![lang],
    /** Sign lord from data/astro/signs.json (standard sign rulerships). */
    signLordAt: (index: number) => SIGNS[((index % 12) + 12) % 12]!.lord,
    nakshatra: (id: string) => NAKSHATRAS.find((n) => n.id === id)?.[lang] ?? id,
    nakshatraRow: (id: string) => NAKSHATRAS.find((n) => n.id === id) ?? null,
    /** Localised name of a table value (varna, gana, yoni, …); falls back to the engine id. */
    attr: (group: string, id: string | null | undefined) =>
      id == null ? "" : (attrs[group]?.[id] ?? id),

    /** "15 Aug 1990": an instant's calendar date in IST. */
    date: (iso: string) =>
      formatInZone(iso, IST, loc, { day: "numeric", month: "short", year: "numeric" }),
    /** "15 August 1990": an instant's calendar date in IST, long form. */
    dateLong: (iso: string) =>
      formatInZone(iso, IST, loc, { day: "numeric", month: "long", year: "numeric" }),
    /** "21 October 2026, 14:00 IST". */
    dateTime: (iso: string) =>
      `${formatInZone(iso, IST, loc, { day: "numeric", month: "long", year: "numeric" })}, ${formatClock(iso, IST)} IST`,
    /** A calendar date as given ("1990-08-15"), not an instant. */
    calendarDate: (isoDate: string) => formatIstDate(isoDate, lang),
    /** Clock time of an instant in the birth place's zone, with the date when it differs. */
    clockOn: (iso: string, tz: string, isoDate: string) => formatClockOnDay(iso, tz, isoDate, lang),
    clock: (iso: string, tz: string) => formatClock(iso, tz),
    /** "1990-08-15T01:00:00Z" → "15 Aug 1990, 01:00 UTC". */
    utc: (iso: string) =>
      `${formatInZone(iso, "UTC", loc, { day: "numeric", month: "short", year: "numeric" })}, ${formatClock(iso, "UTC")} UTC`,
    deg: (n: number, digits = 2) => `${n.toFixed(digits)}°`,
    num: (n: number, digits = 2) => (Number.isInteger(n) ? String(n) : n.toFixed(digits)),
    coords: (lat: number, lon: number) => {
      const ns = lang === "hi" ? (lat >= 0 ? "उ" : "द") : lat >= 0 ? "N" : "S";
      const ew = lang === "hi" ? (lon >= 0 ? "पू" : "प") : lon >= 0 ? "E" : "W";
      return `${Math.abs(lat).toFixed(4)}° ${ns}, ${Math.abs(lon).toFixed(4)}° ${ew}`;
    },
  };
}

export type ReportCtx = ReturnType<typeof reportContext>;
