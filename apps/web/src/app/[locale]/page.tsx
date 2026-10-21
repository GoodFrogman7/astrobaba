import { requireLocale } from "@/lib/almanac/locale";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageShell } from "@/components/PageShell";
import { Link } from "@/i18n/navigation";
import { cityName, DEFAULT_CITY_SLUG, type SeoCity } from "@/lib/almanac/cities";
import { getCity, loadPanchang, requestIstDays } from "@/lib/almanac/data";
import { formatClock, formatIstDate } from "@/lib/almanac/dates";
import { SIGNS } from "@/lib/almanac/names";
import type { Panchang } from "@/lib/almanac/types";
import { getContent } from "@/lib/content";
import { pageMetadata } from "@/lib/seo";

// Shows today's IST date and panchang summary, so it is rendered per request.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props) {
  const { locale: rawLocale } = await params;
  const locale = requireLocale(rawLocale);
  return pageMetadata(locale, "/", await getContent(locale, "home"));
}

async function todaySummary(today: string): Promise<{ data: Panchang; city: SeoCity } | null> {
  try {
    const city = await getCity(DEFAULT_CITY_SLUG);
    if (!city) return null;
    return { data: await loadPanchang(city, today), city };
  } catch {
    return null; // the landing page still renders if the engine is unreachable
  }
}

export default async function HomePage({ params }: Props) {
  const { locale: rawLocale } = await params;
  const locale = requireLocale(rawLocale);
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "almanac.home" });
  const th = await getTranslations({ locale, namespace: "home" });
  const { today } = requestIstDays();
  const dateText = formatIstDate(today, locale);
  const summary = await todaySummary(today);
  const name = (s: { en: string; hi: string }) => (locale === "hi" ? s.hi : s.en);

  const cards = [
    { href: "/kundli", title: t("kundli"), body: t("kundliBody") },
    { href: "/kundli-matching", title: t("matching"), body: t("matchingBody") },
    { href: "/panchang", title: t("panchang"), body: t("panchangBody") },
    { href: "/tools", title: t("tools"), body: t("toolsBody") },
  ];

  return (
    <PageShell locale={locale} crumbs={[]} content={await getContent(locale, "home")}>
      <p className="-mt-4 mb-6 text-sm font-medium text-accent">
        {th("eyebrow", { date: dateText })}
      </p>

      {summary && (
        <section
          aria-labelledby="home-today"
          className="mb-8 rounded-md border border-border bg-surface p-5"
        >
          <h2 id="home-today" className="text-lg font-semibold">
            {t("todayHeading")}
          </h2>
          <dl className="mt-3 grid gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-sm text-muted">{t("sunrise")}</dt>
              <dd className="font-medium">
                {formatClock(summary.data.sunrise, summary.data.place.tz)}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted">{t("tithi")}</dt>
              <dd className="font-medium">
                {summary.data.tithis[0] ? name(summary.data.tithis[0]) : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted">{t("nakshatra")}</dt>
              <dd className="font-medium">
                {summary.data.nakshatras[0] ? name(summary.data.nakshatras[0]) : "—"}
              </dd>
            </div>
          </dl>
          <Link
            href={`/panchang/${summary.city.slug}`}
            className="mt-3 inline-block text-sm underline underline-offset-4"
          >
            {t("fullPanchang")}
            {` · ${cityName(summary.city, locale)}`}
          </Link>
        </section>
      )}

      <section aria-labelledby="home-start">
        <h2 id="home-start" className="text-xl font-semibold">
          {t("explore")}
        </h2>
        <ul className="mt-4 grid gap-4 sm:grid-cols-2">
          {cards.map((c) => (
            <li key={c.href} className="rounded-md border border-border bg-surface p-5">
              <h3 className="font-semibold text-primary">
                <Link href={c.href} className="hover:underline">
                  {c.title}
                </Link>
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{c.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="home-horoscope" className="mt-8">
        <h2 id="home-horoscope" className="text-xl font-semibold">
          <Link href="/horoscope" className="hover:underline">
            {t("horoscope")}
          </Link>
        </h2>
        <p className="mt-2 text-sm text-muted">{t("horoscopeBody")}</p>
        <ul className="mt-3 grid grid-cols-3 gap-2 text-sm sm:grid-cols-6">
          {SIGNS.map((s) => (
            <li key={s.id}>
              <Link href={`/horoscope/daily/${s.id}`} className="hover:underline">
                {s[locale]}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </PageShell>
  );
}
