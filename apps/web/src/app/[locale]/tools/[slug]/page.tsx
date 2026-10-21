import type { Locale } from "@astro/shared";
import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { PageShell } from "@/components/PageShell";
import { ToolRunner } from "@/components/tools/ToolRunner";
import { routing } from "@/i18n/routing";
import { getContent } from "@/lib/content";
import { pageMetadata } from "@/lib/seo";
import { findTool, TOOLS } from "@/lib/tools/registry";

type Props = { params: Promise<{ locale: Locale; slug: string }> };

export function generateStaticParams() {
  return routing.locales.flatMap((locale) => TOOLS.map((t) => ({ locale, slug: t.slug })));
}

export const dynamicParams = false;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params;
  const tool = findTool(slug);
  if (!tool) return {};
  return pageMetadata(locale, `/tools/${slug}`, await getContent(locale, tool.contentKey));
}

export default async function ToolPage({ params }: Props) {
  const { locale, slug } = await params;
  const tool = findTool(slug);
  if (!tool) notFound();
  setRequestLocale(locale);
  const content = await getContent(locale, tool.contentKey);
  const nav = await getTranslations({ locale, namespace: "nav" });
  return (
    <PageShell
      locale={locale}
      crumbs={[
        { name: nav("tools"), path: "/tools" },
        { name: content.h1, path: `/tools/${slug}` },
      ]}
      content={content}
    >
      <ToolRunner slug={tool.slug} form={tool.form} />
    </PageShell>
  );
}
