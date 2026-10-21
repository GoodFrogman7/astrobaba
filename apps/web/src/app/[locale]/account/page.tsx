import type { Locale } from "@astro/shared";
import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { AccountView } from "@/components/trust/AccountView";
import { routing } from "@/i18n/routing";
import { privateMetadata } from "@/lib/seo";

type Props = { params: Promise<{ locale: string }> };

/** Personal page: noindex, not in the sitemap. Static shell; the account loads in the browser. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "trust.account" });
  return privateMetadata(t("title"));
}

export default async function AccountPage({ params }: Props) {
  const { locale: raw } = await params;
  if (!hasLocale(routing.locales, raw)) notFound();
  const locale: Locale = raw;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "trust.account" });
  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-3xl font-semibold tracking-tight">{t("title")}</h1>
      <p className="mt-2 text-muted">{t("intro")}</p>
      <div className="mt-6">
        <AccountView />
      </div>
    </main>
  );
}
