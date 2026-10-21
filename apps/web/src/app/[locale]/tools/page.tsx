import type { Locale } from "@astro/shared";
import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageShell } from "@/components/PageShell";
import { Link } from "@/i18n/navigation";
import { getContent } from "@/lib/content";
import { pageMetadata } from "@/lib/seo";
import { HUB_ENTRIES } from "@/lib/tools/registry";

type Props = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  return pageMetadata(locale, "/tools", await getContent(locale, "tools"));
}

export default async function ToolsHub({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const content = await getContent(locale, "tools");
  const t = await getTranslations({ locale, namespace: "toolNames" });
  const tu = await getTranslations({ locale, namespace: "toolsUi.hub" });
  return (
    <PageShell locale={locale} crumbs={[{ name: content.h1, path: "/tools" }]} content={content}>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {HUB_ENTRIES.map((e) => (
          <li key={e.key} className="rounded-md border border-border bg-surface p-5">
            <h2 className="font-semibold text-primary">
              <Link href={e.href} className="hover:underline">
                {t(`${e.key}.title`)}
              </Link>
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-muted">{t(`${e.key}.blurb`)}</p>
            <Link
              href={e.href}
              className="mt-3 inline-block text-sm font-medium text-accent hover:underline"
            >
              {tu("open")}
            </Link>
          </li>
        ))}
      </ul>
    </PageShell>
  );
}
