import type { Metadata } from "next";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { JsonLd } from "@/components/JsonLd";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { ConsentGate } from "@/components/trust/ConsentGate";
import { routing } from "@/i18n/routing";
import { organizationLd } from "@/lib/seo";
import { SITE_URL } from "@/site";
import "../globals.css";

// Every page uses system fonts only (no web fonts). Devanagari: Noto Sans Devanagari on Android,
// Nirmala UI on Windows, Kohinoor Devanagari on Apple. Web fonts cost us twice on CI: a
// Devanagari font swapping in shifted Hindi pages (CLS 0.25), and the Latin web font delayed
// first paint on English pages (performance 88-89 vs 99-100 on the system-font Hindi pages).
const LATIN_STACK =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Helvetica Neue", Arial';
const DEVANAGARI_STACK =
  '"Noto Sans Devanagari", "Nirmala UI", "Kohinoor Devanagari", "Mangal", "Lohit Devanagari"';

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export const metadata: Metadata = { metadataBase: new URL(SITE_URL) };

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "nav" });

  return (
    <html lang={locale}>
      <body
        className="min-h-dvh font-sans antialiased"
        style={{
          ["--font-body" as string]:
            // Hindi pages put the Devanagari fonts first so Latin digits and words inside Hindi
            // text match them.
            locale === "hi"
              ? `${DEVANAGARI_STACK}, system-ui, sans-serif`
              : `${LATIN_STACK}, ${DEVANAGARI_STACK}`,
        }}
      >
        <NextIntlClientProvider>
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:rounded-sm focus:bg-surface focus:px-3 focus:py-2"
          >
            {t("skipToContent")}
          </a>
          <JsonLd data={organizationLd()} />
          <SiteHeader locale={locale} />
          {children}
          <SiteFooter locale={locale} />
          <ConsentGate />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
