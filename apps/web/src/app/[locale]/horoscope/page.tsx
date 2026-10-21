import { requireLocale } from "@/lib/almanac/locale";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageShell } from "@/components/PageShell";
import { Link } from "@/i18n/navigation";
import { PERIODS, SIGNS } from "@/lib/almanac/names";
import { getContent } from "@/lib/content";
import { pageMetadata } from "@/lib/seo";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props) {
  const { locale: rawLocale } = await params;
  const locale = requireLocale(rawLocale);
  return pageMetadata(locale, "/horoscope", await getContent(locale, "horoscope-hub"));
}

export default async function Page({ params }: Props) {
  const { locale: rawLocale } = await params;
  const locale = requireLocale(rawLocale);
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "almanac.horoscope" });
  const tn = await getTranslations({ locale, namespace: "nav" });
  return (
    <PageShell
      locale={locale}
      crumbs={[{ name: tn("horoscope"), path: "/horoscope" }]}
      content={await getContent(locale, "horoscope-hub")}
    >
      <p className="mb-4 text-sm text-muted">{t("moonSign")}</p>
      <div className="grid gap-6 sm:grid-cols-3">
        {PERIODS.map((period) => (
          <section
            key={period}
            aria-labelledby={`hub-${period}`}
            className="rounded-md border border-border bg-surface p-4"
          >
            <h2 id={`hub-${period}`} className="font-semibold">
              {t(`periods.${period}`)}
            </h2>
            <ul className="mt-2 grid grid-cols-2 gap-1 text-sm">
              {SIGNS.map((s) => (
                <li key={s.id}>
                  <Link href={`/horoscope/${period}/${s.id}`} className="hover:underline">
                    {s[locale]}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </PageShell>
  );
}
