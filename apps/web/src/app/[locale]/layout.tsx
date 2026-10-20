import { BRAND_NAME, DISCLAIMER, type Locale } from "@astro/shared";
import type { Metadata } from "next";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Noto_Sans, Noto_Sans_Devanagari } from "next/font/google";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Link } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { SITE_URL } from "@/site";
import "../globals.css";

const latin = Noto_Sans({ subsets: ["latin"], variable: "--font-latin", display: "swap" });
const devanagari = Noto_Sans_Devanagari({
  subsets: ["devanagari"],
  variable: "--font-devanagari",
  display: "swap",
});

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
  const tf = await getTranslations({ locale, namespace: "footer" });
  const other: Locale = locale === "en" ? "hi" : "en";

  return (
    <html lang={locale} className={`${latin.variable} ${devanagari.variable}`}>
      <body
        className="min-h-dvh font-sans antialiased"
        style={{ ["--font-body" as string]: "var(--font-latin), var(--font-devanagari)" }}
      >
        <NextIntlClientProvider>
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:rounded-sm focus:bg-surface focus:px-3 focus:py-2"
          >
            {t("skipToContent")}
          </a>
          <header className="border-b border-border">
            <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
              <Link href="/" className="text-lg font-semibold tracking-tight">
                {BRAND_NAME}
              </Link>
              <nav aria-label={t("language")}>
                <Link
                  href="/"
                  locale={other}
                  hrefLang={other}
                  className="rounded-sm border border-border px-3 py-1.5 text-sm hover:bg-surface"
                >
                  {t("switchTo")}
                </Link>
              </nav>
            </div>
          </header>
          {children}
          <footer className="mt-16 border-t border-border">
            <div className="mx-auto max-w-5xl space-y-2 px-4 py-8 text-sm text-muted">
              <p data-testid="disclaimer">{DISCLAIMER[locale]}</p>
              <p>{tf("rights", { year: new Date().getUTCFullYear(), brand: BRAND_NAME })}</p>
            </div>
          </footer>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
