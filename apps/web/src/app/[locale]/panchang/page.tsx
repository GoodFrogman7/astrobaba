import type { Locale } from "@astro/shared";
import { requireLocale } from "@/lib/almanac/locale";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { IstDate } from "@/components/almanac/IstDate";
import { PanchangView } from "@/components/almanac/PanchangView";
import { PageShell } from "@/components/PageShell";
import { Link } from "@/i18n/navigation";
import { cityName, DEFAULT_CITY_SLUG, seoCities } from "@/lib/almanac/cities";
import { getCity, loadPanchang, requestIstDays } from "@/lib/almanac/data";
import { formatIstDate } from "@/lib/almanac/dates";
import { fillContent, getContent } from "@/lib/content";
import { pageMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

async function content(locale: Locale) {
  const { today } = requestIstDays();
  return fillContent(await getContent(locale, "panchang-hub"), {
    date: formatIstDate(today, locale),
  });
}

export async function generateMetadata({ params }: Props) {
  const { locale: rawLocale } = await params;
  const locale = requireLocale(rawLocale);
  return pageMetadata(locale, "/panchang", await content(locale));
}

export default async function Page({ params }: Props) {
  const { locale: rawLocale } = await params;
  const locale = requireLocale(rawLocale);
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "almanac.panchang" });
  const tn = await getTranslations({ locale, namespace: "nav" });
  const { today } = requestIstDays();
  const city = await getCity(DEFAULT_CITY_SLUG);
  const data = city ? await loadPanchang(city, today) : null;
  const cities = seoCities();
  return (
    <PageShell
      locale={locale}
      crumbs={[{ name: tn("panchang"), path: "/panchang" }]}
      content={await content(locale)}
    >
      <p className="mb-4 text-lg font-medium text-accent">
        <IstDate date={today} text={formatIstDate(today, locale)} />
      </p>
      {city && data && (
        <section aria-labelledby="pc-today">
          <h2 id="pc-today" className="mb-3 text-xl font-semibold">
            <Link href={`/panchang/${city.slug}`} className="hover:underline">
              {t("todayFor", { city: cityName(city, locale) })}
            </Link>
          </h2>
          <PanchangView data={data} locale={locale} city={cityName(city, locale)} />
        </section>
      )}
      {cities.length > 0 && (
        <nav aria-labelledby="pc-all" className="mt-8">
          <h2 id="pc-all" className="text-xl font-semibold">
            {t("otherCities")}
          </h2>
          <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {cities.map((c) => (
              <li key={c.slug}>
                <Link href={`/panchang/${c.slug}`} className="hover:underline">
                  {cityName(c, locale)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </PageShell>
  );
}
