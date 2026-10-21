import type { Locale } from "@astro/shared";
import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";
import { PageShell } from "@/components/PageShell";
import { KundliRunner } from "@/components/tools/KundliRunner";
import { getContent } from "@/lib/content";
import { pageMetadata } from "@/lib/seo";

type Props = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  return pageMetadata(locale, "/kundli", await getContent(locale, "kundli"));
}

export default async function KundliPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const content = await getContent(locale, "kundli");
  return (
    <PageShell locale={locale} crumbs={[{ name: content.h1, path: "/kundli" }]} content={content}>
      <KundliRunner />
    </PageShell>
  );
}
