import type { Locale } from "@astro/shared";
import { requireLocale } from "@/lib/almanac/locale";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { HoroscopeView } from "@/components/almanac/HoroscopeView";
import { IstDate } from "@/components/almanac/IstDate";
import { PageShell } from "@/components/PageShell";
import { Link } from "@/i18n/navigation";
import { loadFacts, loadPublished, requestIstDays } from "@/lib/almanac/data";
import { formatIstDate } from "@/lib/almanac/dates";
import { PERIODS, type Period, SIGN_IDS, SIGNS, signName } from "@/lib/almanac/names";
import { fillContent, getContent } from "@/lib/content";
import { pageMetadata } from "@/lib/seo";

// Scores depend on the IST date at request time; data is cached per IST date.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string; period: string; sign: string }> };

function check(period: string, sign: string): { period: Period; sign: string } {
  if (!(PERIODS as readonly string[]).includes(period) || !SIGN_IDS.includes(sign)) notFound();
  return { period: period as Period, sign };
}

async function prepare(locale: Locale, periodParam: string, signParam: string) {
  const { period, sign } = check(periodParam, signParam);
  const { today } = requestIstDays();
  const facts = await loadFacts(sign, period, today);
  const t = await getTranslations({ locale, namespace: "almanac.horoscope" });
  const start = formatIstDate(facts.window.start_ist_date, locale);
  const end = formatIstDate(facts.window.end_ist_date, locale);
  const windowText = t(`window.${period}`, { start, end });
  const c = fillContent(await getContent(locale, `horoscope-${period}`), {
    sign: signName(sign, locale),
    window: windowText,
  });
  return { period, sign, today, facts, windowText, content: c, t };
}

export async function generateMetadata({ params }: Props) {
  const { locale: rawLocale, period, sign } = await params;
  const locale = requireLocale(rawLocale);
  const p = await prepare(locale, period, sign);
  return pageMetadata(locale, `/horoscope/${p.period}/${p.sign}`, p.content);
}

export default async function Page({ params }: Props) {
  const { locale: rawLocale, period: periodParam, sign: signParam } = await params;
  const locale = requireLocale(rawLocale);
  setRequestLocale(locale);
  const p = await prepare(locale, periodParam, signParam);
  const tn = await getTranslations({ locale, namespace: "nav" });
  const published = await loadPublished(p.period, p.sign, p.today, locale);
  const signLabel = signName(p.sign, locale);
  return (
    <PageShell
      locale={locale}
      crumbs={[
        { name: tn("horoscope"), path: "/horoscope" },
        {
          name: `${signLabel} · ${p.t(`periods.${p.period}`)}`,
          path: `/horoscope/${p.period}/${p.sign}`,
        },
      ]}
      content={p.content}
      aside={
        <nav
          aria-labelledby="hs-nav"
          className="rounded-md border border-border bg-surface p-4 text-sm"
        >
          <h2 id="hs-nav" className="font-semibold">
            {p.t("otherPeriods", { sign: signLabel })}
          </h2>
          <ul className="mt-2 space-y-1">
            {PERIODS.filter((x) => x !== p.period).map((x) => (
              <li key={x}>
                <Link href={`/horoscope/${x}/${p.sign}`} className="hover:underline">
                  {p.t(`periods.${x}`)}
                </Link>
              </li>
            ))}
          </ul>
          <h2 className="mt-4 font-semibold">{p.t("allSigns")}</h2>
          <ul className="mt-2 grid grid-cols-2 gap-1">
            {SIGNS.map((s) => (
              <li key={s.id}>
                <Link href={`/horoscope/${p.period}/${s.id}`} className="hover:underline">
                  {s[locale]}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      }
    >
      <p className="mb-4 text-lg font-medium text-accent">
        {p.period === "daily" ? <IstDate date={p.today} text={p.windowText} /> : p.windowText}
      </p>
      <HoroscopeView
        facts={p.facts}
        published={published}
        locale={locale}
        windowText={p.windowText}
      />
    </PageShell>
  );
}
