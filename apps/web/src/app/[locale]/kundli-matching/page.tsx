import type { Locale } from "@astro/shared";
import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";
import { PageShell } from "@/components/PageShell";
import { MatchRunner } from "@/components/tools/MatchRunner";
import { getContent } from "@/lib/content";
import { pageMetadata } from "@/lib/seo";

type Props = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  return pageMetadata(locale, "/kundli-matching", await getContent(locale, "kundli-matching"));
}

export default async function MatchingPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const content = await getContent(locale, "kundli-matching");
  return (
    <PageShell
      locale={locale}
      crumbs={[{ name: content.h1, path: "/kundli-matching" }]}
      content={content}
    >
      <MatchRunner />
    </PageShell>
  );
}
