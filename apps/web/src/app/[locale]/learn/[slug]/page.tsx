import { DISCLAIMER, LOCALES, type Locale } from "@astro/shared";
import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { ExpertCta } from "@/components/ExpertCta";
import { JsonLd } from "@/components/JsonLd";
import { ArticleMeta } from "@/components/learn/ArticleMeta";
import { Breadcrumbs } from "@/components/learn/Breadcrumbs";
import { Link } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { learnSource, TOOL_HREFS } from "@/lib/learn";
import { articleLd, onlyLocales, pageMetadata } from "@/lib/seo";

type Props = { params: Promise<{ locale: string; slug: string }> };

/** Only published, reviewed articles are built; every other slug is 404. */
export function generateStaticParams() {
  const source = learnSource();
  return LOCALES.flatMap((locale) => source.list(locale).map((a) => ({ locale, slug: a.slug })));
}

export const dynamicParams = false;

const pathOf = (slug: string) => `/learn/${slug}`;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const source = learnSource();
  const a = source.get(locale, slug);
  if (!a) return {};
  const meta = pageMetadata(locale, pathOf(slug), a);
  return onlyLocales(
    {
      ...meta,
      openGraph: {
        ...meta.openGraph,
        type: "article",
        publishedTime: a.published_at,
        modifiedTime: a.updated_at,
        authors: [a.author],
      },
    },
    pathOf(slug),
    source.locales(slug),
  );
}

/** One /learn article (docs/api/growth.md §3). */
export default async function LearnArticle({ params }: Props) {
  const { locale: raw, slug } = await params;
  if (!hasLocale(routing.locales, raw)) notFound();
  const locale: Locale = raw;
  setRequestLocale(locale);
  const a = learnSource().get(locale, slug);
  if (!a) notFound();
  const [t, names, nav] = await Promise.all([
    getTranslations({ locale, namespace: "growth.learn" }),
    getTranslations({ locale, namespace: "toolNames" }),
    getTranslations({ locale, namespace: "nav" }),
  ]);
  const path = pathOf(slug);
  const toolName = (tool: string) =>
    tool === "kundli-matching" ? nav("matching") : names(`${tool}.title`);
  return (
    <main id="main" className="mx-auto max-w-5xl px-4 py-8">
      <JsonLd
        data={articleLd(locale, path, {
          headline: a.h1,
          description: a.description,
          author: a.author,
          datePublished: a.published_at,
          dateModified: a.updated_at,
        })}
      />
      <Breadcrumbs
        locale={locale}
        crumbs={[
          { name: t("learnCrumb"), path: "/learn" },
          { name: a.h1, path },
        ]}
      />
      <article className="mt-4 max-w-3xl">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{a.h1}</h1>
        <ArticleMeta a={a} locale={locale} />
        <p className="mt-6 text-lg leading-relaxed text-muted">{a.intro}</p>
        <div className="mt-8 space-y-8">
          {a.sections.map((s) => (
            <section key={s.heading}>
              <h2 className="text-xl font-semibold">{s.heading}</h2>
              {s.body.map((p) => (
                <p key={p.slice(0, 40)} className="mt-3 leading-relaxed">
                  {p}
                </p>
              ))}
            </section>
          ))}
        </div>
        <aside
          role="note"
          className="mt-10 rounded-md border border-border bg-surface p-4"
          data-testid="article-disclaimer"
        >
          <p className="font-semibold">{t("noteHeading")}</p>
          <p className="mt-1 text-sm">{DISCLAIMER[locale]}</p>
        </aside>
      </article>

      {a.related_tools.length > 0 && (
        <nav aria-labelledby="related-tools" className="mt-10" data-testid="related-tools">
          <h2 id="related-tools" className="text-lg font-semibold">
            {t("relatedTools")}
          </h2>
          <ul className="mt-2 flex flex-wrap gap-x-4">
            {a.related_tools.map((tool) => (
              <li key={tool}>
                <Link
                  href={TOOL_HREFS[tool] ?? "/tools"}
                  className="inline-block py-1.5 text-accent underline"
                >
                  {toolName(tool)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}

      <ExpertCta locale={locale} />
    </main>
  );
}
