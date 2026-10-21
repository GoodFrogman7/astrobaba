import type { Metadata } from "next";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Noto_Sans } from "next/font/google";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { JsonLd } from "@/components/JsonLd";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { routing } from "@/i18n/routing";
import { organizationLd } from "@/lib/seo";
import { SITE_URL } from "@/site";
import "../globals.css";

const latin = Noto_Sans({ subsets: ["latin"], variable: "--font-latin", display: "swap" });

// Devanagari uses the system font on every platform (Noto Sans Devanagari on Android, Nirmala UI
// on Windows, Kohinoor Devanagari on Apple). A ~120 KB web font swapping in caused layout shift
// on Hindi pages (Lighthouse CLS 0.25), and these system fonts are good.
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
    <html lang={locale} className={latin.variable}>
      <body
        className="min-h-dvh font-sans antialiased"
        style={{
          ["--font-body" as string]:
            // Hindi pages lead with the system Devanagari fonts (they include Latin letters), so
            // text never waits for the Latin web font; English pages lead with the web font.
            locale === "hi"
              ? `${DEVANAGARI_STACK}, var(--font-latin)`
              : `var(--font-latin), ${DEVANAGARI_STACK}`,
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
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
