import type { Locale } from "@astro/shared";
import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import type { PageContent } from "@/lib/content";
import { breadcrumbLd, faqLd } from "@/lib/seo";
import { ExpertCta } from "./ExpertCta";
import { JsonLd } from "./JsonLd";

export interface Crumb {
  name: string;
  path: string;
}

/**
 * Template for every indexable page: breadcrumbs (visible + JSON-LD), h1 and intro, the page's
 * computed or interactive part, explanatory sections, FAQs (visible + FAQPage JSON-LD) and the
 * consultation call-to-action. Organization JSON-LD and the disclaimer come from the layout.
 */
export async function PageShell({
  locale,
  crumbs,
  content,
  children,
  aside,
  cta = true,
}: {
  locale: Locale;
  crumbs: Crumb[];
  content: PageContent;
  children?: ReactNode;
  aside?: ReactNode;
  cta?: boolean;
}) {
  const t = await getTranslations({ locale, namespace: "shell" });
  const trail = [{ name: t("home"), path: "/" }, ...crumbs];
  return (
    <main id="main" className="mx-auto max-w-5xl px-4 py-8">
      <JsonLd data={breadcrumbLd(locale, trail)} />
      {content.faqs.length > 0 && <JsonLd data={faqLd(content.faqs)} />}
      <nav aria-label={t("breadcrumbs")} className="text-sm text-muted">
        <ol className="flex flex-wrap gap-1">
          {trail.map((c, i) => (
            <li key={c.path} className="flex gap-1">
              {i > 0 && <span aria-hidden="true">/</span>}
              {i < trail.length - 1 ? (
                <Link href={c.path} className="underline-offset-2 hover:underline">
                  {c.name}
                </Link>
              ) : (
                <span aria-current="page">{c.name}</span>
              )}
            </li>
          ))}
        </ol>
      </nav>

      <h1 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">{content.h1}</h1>
      <p className="mt-3 max-w-3xl text-lg leading-relaxed text-muted">{content.intro}</p>

      {children && <div className="mt-8">{children}</div>}

      <div className="mt-10 grid gap-10 lg:grid-cols-[1fr_18rem]">
        <article className="max-w-3xl space-y-8">
          {content.sections.map((s) => (
            <section key={s.heading}>
              <h2 className="text-xl font-semibold">{s.heading}</h2>
              {s.body.map((p) => (
                <p key={p.slice(0, 40)} className="mt-3 leading-relaxed">
                  {p}
                </p>
              ))}
            </section>
          ))}
          {content.faqs.length > 0 && (
            <section aria-labelledby="faq">
              <h2 id="faq" className="text-xl font-semibold">
                {t("faq")}
              </h2>
              <div className="mt-3 divide-y divide-border rounded-md border border-border bg-surface">
                {content.faqs.map((f) => (
                  <details key={f.q} className="group p-4">
                    <summary className="cursor-pointer font-medium">{f.q}</summary>
                    <p className="mt-2 leading-relaxed text-muted">{f.a}</p>
                  </details>
                ))}
              </div>
            </section>
          )}
        </article>
        {aside && <aside className="space-y-6">{aside}</aside>}
      </div>

      {cta && <ExpertCta locale={locale} />}
    </main>
  );
}
