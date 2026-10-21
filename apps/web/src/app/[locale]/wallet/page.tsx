import type { Locale } from "@astro/shared";
import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { WalletView } from "@/components/billing/WalletView";
import { routing } from "@/i18n/routing";
import { privateMetadata } from "@/lib/seo";

type Props = { params: Promise<{ locale: string }> };

/** Personal page: noindex, not in the sitemap. Static shell; the wallet loads in the browser. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "billing.wallet" });
  return privateMetadata(t("title"));
}

export default async function WalletPage({ params }: Props) {
  const { locale: raw } = await params;
  if (!hasLocale(routing.locales, raw)) notFound();
  const locale: Locale = raw;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "billing.wallet" });
  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-3xl font-semibold tracking-tight">{t("title")}</h1>
      <div className="mt-6">
        <Suspense fallback={<p className="text-muted">{t("loading")}</p>}>
          <WalletView />
        </Suspense>
      </div>
    </main>
  );
}
