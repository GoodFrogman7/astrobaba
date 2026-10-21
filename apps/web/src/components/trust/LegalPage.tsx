import type { Locale } from "@astro/shared";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { JsonLd } from "@/components/JsonLd";
import { Link } from "@/i18n/navigation";
import { breadcrumbLd } from "@/lib/seo";
import type { LegalContent } from "@/lib/trust/content";
import { LEGAL_PAGES, LEGAL_PATHS, type LegalPageKey } from "@/lib/trust/pages";
import { isDraft } from "@/lib/trust/types";

/**
 * Template for the policy pages: breadcrumbs (visible + JSON-LD), title, the policy version,
 * a "Draft — under legal review" note while the version is not approved, the sections (with
 * data blocks in their slots and the parts the lawyer must still complete), and links to the
 * other policies.
 */
export async function LegalPage({
  locale,
  page,
  content,
  version,
  status,
  slots = {},
}: {
  locale: Locale;
  page: LegalPageKey;
  content: LegalContent;
  version: string;
  status: string;
  slots?: Record<string, ReactNode>;
}) {
  const [t, ts, tl] = await Promise.all([
    getTranslations({ locale, namespace: "trust.legal" }),
    getTranslations({ locale, namespace: "shell" }),
    getTranslations({ locale, namespace: "trust.links" }),
  ]);
  const path = LEGAL_PATHS[page];
  const trail = [
    { name: ts("home"), path: "/" },
    { name: content.h1, path },
  ];
  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-8">
      <JsonLd data={breadcrumbLd(locale, trail)} />
      <nav aria-label={ts("breadcrumbs")} className="text-sm text-muted">
        <ol className="flex flex-wrap gap-1">
          <li>
            <Link href="/" className="underline-offset-2 hover:underline">
              {ts("home")}
            </Link>
          </li>
          <li className="flex gap-1">
            <span aria-hidden="true">/</span>
            <span aria-current="page">{content.h1}</span>
          </li>
        </ol>
      </nav>

      <h1 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">{content.h1}</h1>
      <p className="mt-2 text-sm text-muted" data-testid="legal-version">
        {t("version", { version })}
      </p>
      {isDraft(status) && (
        <div
          role="note"
          className="mt-4 rounded-md border-2 border-dashed border-accent p-4"
          data-testid="legal-draft"
        >
          <p className="font-semibold">{t("draftTitle")}</p>
          <p className="mt-1 text-sm">{t("draftBody")}</p>
        </div>
      )}
      <p className="mt-6 text-lg leading-relaxed">{content.intro}</p>

      <article className="mt-8 space-y-8">
        {content.sections.map((s) => (
          <section key={s.id} id={s.id} aria-labelledby={`${s.id}-h`}>
            <h2 id={`${s.id}-h`} className="text-xl font-semibold">
              {s.heading}
            </h2>
            {s.body.map((p) => (
              <p key={p.slice(0, 48)} className="mt-3 leading-relaxed">
                {p}
              </p>
            ))}
            {s.slot && slots[s.slot] ? <div className="mt-4">{slots[s.slot]}</div> : null}
            {s.lawyer && isDraft(status) && (
              <p
                className="mt-3 rounded-sm border border-border bg-surface p-3 text-sm"
                data-testid="lawyer-todo"
              >
                <span className="font-semibold">{t("lawyer")}</span> {s.lawyer}
              </p>
            )}
          </section>
        ))}
      </article>

      <nav aria-label={t("related")} className="mt-12 border-t border-border pt-6">
        <h2 className="text-lg font-semibold">{t("related")}</h2>
        <ul className="mt-2 flex flex-wrap gap-x-4 text-sm">
          {LEGAL_PAGES.filter((k) => k !== page).map((k) => (
            <li key={k}>
              <Link href={LEGAL_PATHS[k]} className="inline-block py-1.5 text-accent underline">
                {tl(k)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </main>
  );
}

/** "To be published before launch" for a value the founder has not filled in yet. */
export function Pending({ text }: { text: string }) {
  return (
    <span className="italic text-muted" data-testid="to-be-published">
      {text}
    </span>
  );
}
