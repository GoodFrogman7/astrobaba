import type { Locale } from "@astro/shared";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { PageShell } from "@/components/PageShell";
import { Link } from "@/i18n/navigation";
import { cityName, seoCities, type SeoCity } from "@/lib/almanac/cities";
import { getCity, loadPanchang, requestIstDays } from "@/lib/almanac/data";
import { addDays, daysBetween, formatIstDate, parseIsoDate } from "@/lib/almanac/dates";
import { fillContent, getContent } from "@/lib/content";
import { pageMetadata } from "@/lib/seo";
import { IstDate } from "./IstDate";
import { PanchangView } from "./PanchangView";

export type PanchangMode = "today" | "tomorrow" | "date";

interface Resolved {
  city: SeoCity;
  date: string;
  path: string;
  index: boolean;
}

async function resolve(slug: string, mode: PanchangMode, dateParam?: string): Promise<Resolved> {
  const city = await getCity(slug);
  if (!city) notFound();
  const { today, tomorrow } = requestIstDays();
  if (mode === "today") return { city, date: today, path: `/panchang/${slug}`, index: true };
  if (mode === "tomorrow")
    return { city, date: tomorrow, path: `/panchang/${slug}/tomorrow`, index: true };
  const date = parseIsoDate(dateParam ?? "");
  if (!date) notFound();
  // Dated pages are reachable and canonical to themselves, but far-off dates stay out of the index.
  return {
    city,
    date,
    path: `/panchang/${slug}/${date}`,
    index: Math.abs(daysBetween(today, date)) <= 400,
  };
}

async function content(locale: Locale, r: Resolved) {
  const c = await getContent(locale, "panchang-city");
  return fillContent(c, { city: cityName(r.city, locale), date: formatIstDate(r.date, locale) });
}

export async function panchangMetadata(
  locale: Locale,
  slug: string,
  mode: PanchangMode,
  dateParam?: string,
): Promise<Metadata> {
  const r = await resolve(slug, mode, dateParam);
  return pageMetadata(locale, r.path, await content(locale, r), { index: r.index });
}

export async function PanchangPage({
  locale,
  slug,
  mode,
  dateParam,
}: {
  locale: Locale;
  slug: string;
  mode: PanchangMode;
  dateParam?: string;
}) {
  const r = await resolve(slug, mode, dateParam);
  const t = await getTranslations({ locale, namespace: "almanac.panchang" });
  const tn = await getTranslations({ locale, namespace: "nav" });
  const [c, data] = await Promise.all([content(locale, r), loadPanchang(r.city, r.date)]);
  const name = cityName(r.city, locale);
  const { today, tomorrow } = requestIstDays();
  const dayPath = (d: string) =>
    d === today
      ? `/panchang/${slug}`
      : d === tomorrow
        ? `/panchang/${slug}/tomorrow`
        : `/panchang/${slug}/${d}`;
  const others = seoCities()
    .filter((x) => x.slug !== slug)
    .slice(0, 12);

  return (
    <PageShell
      locale={locale}
      crumbs={[
        { name: tn("panchang"), path: "/panchang" },
        { name, path: r.path },
      ]}
      content={c}
      aside={
        others.length > 0 && (
          <nav
            aria-labelledby="pc-cities"
            className="rounded-md border border-border bg-surface p-4"
          >
            <h2 id="pc-cities" className="font-semibold">
              {t("otherCities")}
            </h2>
            <ul className="mt-2 grid grid-cols-2 gap-1 text-sm">
              {others.map((o) => (
                <li key={o.slug}>
                  <Link href={`/panchang/${o.slug}`} className="hover:underline">
                    {cityName(o, locale)}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )
      }
    >
      <p className="mb-4 text-lg font-medium text-accent">
        <IstDate date={r.date} text={formatIstDate(r.date, locale)} />
      </p>
      <nav aria-label={t("elements")} className="mb-6 flex flex-wrap gap-2 text-sm">
        <Link
          className="rounded-sm border border-border px-3 py-1.5 hover:bg-surface"
          href={dayPath(addDays(r.date, -1))}
        >
          ← {t("prevDay")}
        </Link>
        {r.date !== today && (
          <Link
            className="rounded-sm border border-border px-3 py-1.5 hover:bg-surface"
            href={`/panchang/${slug}`}
          >
            {t("today")}
          </Link>
        )}
        {r.date !== tomorrow && (
          <Link
            className="rounded-sm border border-border px-3 py-1.5 hover:bg-surface"
            href={`/panchang/${slug}/tomorrow`}
          >
            {t("tomorrow")}
          </Link>
        )}
        <Link
          className="rounded-sm border border-border px-3 py-1.5 hover:bg-surface"
          href={dayPath(addDays(r.date, 1))}
        >
          {t("nextDay")} →
        </Link>
      </nav>
      <PanchangView data={data} locale={locale} city={name} />
    </PageShell>
  );
}
