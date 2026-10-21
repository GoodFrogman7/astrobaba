import type { Locale } from "@astro/shared";
import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { StatusPanel } from "@/components/marketplace/StatusPanel";
import { routing } from "@/i18n/routing";

type Props = { params: Promise<{ locale: string }> };

/** Personal page: never indexed, not in the sitemap. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "market.status" });
  return { title: t("title"), robots: { index: false, follow: false } };
}

export default async function StatusPage({ params }: Props) {
  const { locale: raw } = await params;
  if (!hasLocale(routing.locales, raw)) notFound();
  const locale: Locale = raw;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "market.status" });
  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-3xl font-semibold tracking-tight">{t("title")}</h1>
      <div className="mt-6">
        <StatusPanel />
      </div>
    </main>
  );
}
