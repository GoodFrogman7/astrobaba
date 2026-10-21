import { flagEnabled, REPORT_SKUS, type Locale } from "@astro/shared";
import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { JsonLd } from "@/components/JsonLd";
import { PageShell } from "@/components/PageShell";
import { ReportBuyButton } from "@/components/revenue/ReportBuyButton";
import { Link } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { getContent } from "@/lib/content";
import { formatPaise } from "@/lib/marketplace/format";
import { loadReportProducts } from "@/lib/revenue/data";
import { reportProductLd } from "@/lib/revenue/jsonld";
import { pageMetadata } from "@/lib/seo";

// Static and cookie-free; prices are re-read from the API at most every 10 minutes (ISR).
// Literal (not imported) so Next.js can read it at build time; same value as REVALIDATE_S.
export const revalidate = 600;

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  return pageMetadata(locale, "/reports", await getContent(locale, "reports"));
}

export default async function ReportsPage({ params }: Props) {
  const { locale: raw } = await params;
  if (!hasLocale(routing.locales, raw)) notFound();
  const locale: Locale = raw;
  setRequestLocale(locale);
  const [content, products, t, tr] = await Promise.all([
    getContent(locale, "reports"),
    loadReportProducts(),
    getTranslations({ locale, namespace: "revenue.reports" }),
    getTranslations({ locale, namespace: "revenue" }),
  ]);
  const fmt = (p: number) => formatPaise(p, locale);
  const ai = flagEnabled("ai_assistant");

  return (
    <PageShell locale={locale} crumbs={[{ name: content.h1, path: "/reports" }]} content={content}>
      {products?.map((p) => (
        <JsonLd
          key={p.sku}
          data={reportProductLd(locale, p, {
            name: tr(`sku.${p.sku}`),
            description: t(`blurb.${p.sku}`),
          })}
        />
      ))}
      <ul className="grid gap-6 lg:grid-cols-2">
        {REPORT_SKUS.map((sku) => {
          const p = products?.find((x) => x.sku === sku) ?? null;
          const contents = t.raw(`contents.${sku}`) as string[];
          return (
            <li
              key={sku}
              className="flex flex-col rounded-md border border-border bg-surface p-5"
              data-testid={`product-${sku}`}
            >
              <h2 className="text-xl font-semibold">{tr(`sku.${sku}`)}</h2>
              <p className="mt-2 leading-relaxed text-muted">{t(`blurb.${sku}`)}</p>
              <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-muted">{t("price")}</dt>
                  <dd className="text-lg font-semibold tabular-nums">
                    {p ? fmt(p.price_paise) : t("priceAtCheckout")}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">{t("length")}</dt>
                  <dd className="font-medium">
                    {p ? t("pages", { count: p.pages_estimate }) : t("pagesUnknown")}
                  </dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-muted">{t("languages")}</dt>
                  <dd className="font-medium">
                    {(p?.languages ?? (["en", "hi"] as const))
                      .map((l) => tr(`languages.${l}`))
                      .join(" · ")}
                  </dd>
                </div>
              </dl>
              <h3 className="mt-5 font-semibold">{t("inside")}</h3>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm leading-relaxed">
                {contents.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ol>
              <div className="mt-5 text-sm">
                <p className="font-medium">{t("sample")}</p>
                <p className="mt-1 text-muted">{t("sampleNote")}</p>
                <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                  {(["en", "hi"] as const).map((l) => (
                    <a
                      key={l}
                      href={`/api/reports/sample?sku=${sku}&language=${l}`}
                      rel="nofollow"
                      download
                      className="inline-block py-1 text-accent underline"
                    >
                      {t("sampleLink", { language: tr(`languages.${l}`) })}
                    </a>
                  ))}
                </p>
              </div>
              <div className="mt-auto pt-6">
                <ReportBuyButton sku={sku} products={products} />
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-6 text-sm text-muted">
        {t("already")}{" "}
        <Link href="/account/reports" className="text-accent underline">
          {t("myReports")}
        </Link>
        {ai && (
          <>
            {" · "}
            <Link href="/ai" className="text-accent underline">
              {t("askAi")}
            </Link>
          </>
        )}
      </p>
    </PageShell>
  );
}
