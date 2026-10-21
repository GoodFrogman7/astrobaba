import { LOCALES, type Locale } from "@astro/shared";
import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { ArticleMeta } from "@/components/learn/ArticleMeta";
import { Breadcrumbs } from "@/components/learn/Breadcrumbs";
import { Link } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { learnSource } from "@/lib/learn";
import { onlyLocales, pageMetadata } from "@/lib/seo";

type Props = { params: Promise<{ locale: string }> };

const PATH = "/learn";

/** Locales with at least one published, reviewed article; /learn is 404 everywhere else. */
function hubLocales(): Locale[] {
  const source = learnSource();
  return LOCALES.filter((l) => source.list(l).length > 0);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale) || !hubLocales().includes(locale)) return {};
  const t = await getTranslations({ locale, namespace: "growth.learn" });
  return onlyLocales(
    pageMetadata(locale, PATH, { title: t("title"), description: t("description") }),
    PATH,
    hubLocales(),
  );
}

/** /learn: published articles, newest first (docs/api/growth.md §3). */
export default async function LearnIndex({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const articles = learnSource().list(locale);
  if (!articles.length) notFound();
  const t = await getTranslations({ locale, namespace: "growth.learn" });
  return (
    <main id="main" className="mx-auto max-w-5xl px-4 py-8">
      <Breadcrumbs locale={locale} crumbs={[{ name: t("learnCrumb"), path: PATH }]} />
      <h1 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">{t("h1")}</h1>
      <p className="mt-3 max-w-3xl text-lg leading-relaxed text-muted">{t("intro")}</p>

      <section aria-labelledby="articles" className="mt-10">
        <h2 id="articles" className="text-xl font-semibold">
          {t("listHeading")}
        </h2>
        <ul className="mt-4 grid gap-4 sm:grid-cols-2" data-testid="article-list">
          {articles.map((a) => (
            <li key={a.slug} className="rounded-md border border-border bg-surface p-5">
              <h3 className="font-semibold text-primary">
                <Link href={`${PATH}/${a.slug}`} className="hover:underline">
                  {a.h1}
                </Link>
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{a.description}</p>
              <ArticleMeta a={a} locale={locale} />
              <Link
                href={`${PATH}/${a.slug}`}
                className="mt-3 inline-block text-sm font-medium text-accent hover:underline"
              >
                {t("read")}
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="standards" className="mt-10 max-w-3xl">
        <h2 id="standards" className="text-xl font-semibold">
          {t("standardsHeading")}
        </h2>
        {[0, 1].map((i) => (
          <p key={i} className="mt-3 leading-relaxed">
            {t(`standards.${i}`)}
          </p>
        ))}
      </section>
    </main>
  );
}
