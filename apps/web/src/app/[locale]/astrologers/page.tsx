import type { Locale } from "@astro/shared";
import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { AstrologerCard } from "@/components/marketplace/AstrologerCard";
import { CategoryChips } from "@/components/marketplace/CategoryChips";
import { EmptyState } from "@/components/marketplace/EmptyState";
import { FilterForm } from "@/components/marketplace/FilterForm";
import { PageShell } from "@/components/PageShell";
import { Link } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { getContent } from "@/lib/content";
import { listAstrologers } from "@/lib/marketplace/data";
import {
  hasFilters,
  parseCursor,
  parseFilters,
  type Query,
  toPageQuery,
} from "@/lib/marketplace/filters";
import { pageMetadata } from "@/lib/seo";

// Presence and filters change per request; the API does the filtering (server-side).
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }>; searchParams: Promise<Query> };

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const q = await searchParams;
  // Filtered or paged views are noindex; the canonical is always the plain directory.
  const index = !hasFilters(parseFilters(q)) && !parseCursor(q);
  return pageMetadata(locale, "/astrologers", await getContent(locale, "astrologers"), { index });
}

export default async function Directory({ params, searchParams }: Props) {
  const { locale: raw } = await params;
  if (!hasLocale(routing.locales, raw)) notFound();
  const locale: Locale = raw;
  setRequestLocale(locale);
  const q = await searchParams;
  const filters = parseFilters(q);
  const cursor = parseCursor(q);
  const [content, list, t] = await Promise.all([
    getContent(locale, "astrologers"),
    listAstrologers(filters, cursor),
    getTranslations({ locale, namespace: "market.directory" }),
  ]);
  const filtered = hasFilters(filters);

  return (
    <PageShell
      locale={locale}
      crumbs={[{ name: content.h1, path: "/astrologers" }]}
      content={content}
      cta={false}
    >
      <div className="space-y-5">
        <CategoryChips filters={filters} />
        <FilterForm filters={filters} />
        {!list.ok ? (
          <p className="rounded-md border border-border bg-surface p-4" role="status">
            {t("unavailable")}
          </p>
        ) : list.data.total === 0 && !filtered ? (
          <EmptyState />
        ) : (
          <section aria-labelledby="results">
            <h2 id="results" className="text-lg font-semibold" aria-live="polite">
              {t("results", { total: list.data.total })}
            </h2>
            {list.data.items.length === 0 ? (
              <p className="mt-2 text-muted">{t("noMatch")}</p>
            ) : (
              <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {list.data.items.map((a) => (
                  <li key={a.id}>
                    <AstrologerCard a={a} />
                  </li>
                ))}
              </ul>
            )}
            {list.data.next_cursor && (
              <Link
                href={`/astrologers${toPageQuery(filters, { cursor: list.data.next_cursor })}`}
                rel="nofollow"
                className="mt-6 inline-block rounded-sm border border-primary px-4 py-2 font-medium text-primary"
              >
                {t("loadMore")}
              </Link>
            )}
          </section>
        )}
      </div>
    </PageShell>
  );
}
