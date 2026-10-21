import type { Locale } from "@astro/shared";
import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { ApplyGate } from "@/components/marketplace/ApplyGate";
import { PageShell } from "@/components/PageShell";
import { routing } from "@/i18n/routing";
import { getContent } from "@/lib/content";
import { pageMetadata } from "@/lib/seo";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  return pageMetadata(locale, "/astrologers/apply", await getContent(locale, "astrologers-apply"));
}

export default async function ApplyPage({ params }: Props) {
  const { locale: raw } = await params;
  if (!hasLocale(routing.locales, raw)) notFound();
  const locale: Locale = raw;
  setRequestLocale(locale);
  const content = await getContent(locale, "astrologers-apply");
  const directory = await getContent(locale, "astrologers");
  return (
    <PageShell
      locale={locale}
      crumbs={[
        { name: directory.h1, path: "/astrologers" },
        { name: content.h1, path: "/astrologers/apply" },
      ]}
      content={content}
      cta={false}
    >
      <ApplyGate />
    </PageShell>
  );
}
