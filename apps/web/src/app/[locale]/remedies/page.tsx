import type { Locale } from "@astro/shared";
import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { PageShell } from "@/components/PageShell";
import { RemedyRequest } from "@/components/revenue/RemedyRequest";
import { routing } from "@/i18n/routing";
import { getContent } from "@/lib/content";
import { REMEDIES_INDEXABLE } from "@/lib/revenue/config";
import { loadRemedies } from "@/lib/revenue/data";
import { pageMetadata } from "@/lib/seo";

// Static and cookie-free; the catalogue is re-read from the API at most every 10 minutes.
export const revalidate = 600;

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  return pageMetadata(locale, "/remedies", await getContent(locale, "remedies"), {
    index: REMEDIES_INDEXABLE,
  });
}

export default async function RemediesPage({ params }: Props) {
  const { locale: raw } = await params;
  if (!hasLocale(routing.locales, raw)) notFound();
  const locale: Locale = raw;
  setRequestLocale(locale);
  const [content, remedies, t] = await Promise.all([
    getContent(locale, "remedies"),
    loadRemedies(),
    getTranslations({ locale, namespace: "revenue.remedies" }),
  ]);

  return (
    <PageShell
      locale={locale}
      crumbs={[{ name: content.h1, path: "/remedies" }]}
      content={content}
      cta={false}
    >
      <p
        className="mb-6 rounded-md border border-border bg-surface p-4 text-sm font-medium"
        data-testid="remedies-promise"
      >
        {t("noSale")}
      </p>
      {remedies === null ? (
        <p role="status">{t("unavailable")}</p>
      ) : remedies.length === 0 ? (
        <p role="status" data-testid="remedies-empty">
          {t("empty")}
        </p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {remedies.map((r) => (
            <li key={r.id} className="flex flex-col rounded-md border border-border bg-surface p-5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted">
                {t.has(`kinds.${r.kind}`) ? t(`kinds.${r.kind}`) : null}
              </p>
              <h2 className="mt-1 text-lg font-semibold">{r.name[locale]}</h2>
              <p className="mt-2 text-sm leading-relaxed">{r.description[locale]}</p>
              <p className="mt-2 text-sm text-muted">{r.price_note[locale]}</p>
              <div className="mt-auto pt-4">
                <RemedyRequest remedyId={r.id} name={r.name[locale]} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  );
}
