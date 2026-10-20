import { BRAND_NAME, type Locale } from "@astro/shared";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";

export const NAV = [
  { key: "kundli", href: "/kundli" },
  { key: "matching", href: "/kundli-matching" },
  { key: "panchang", href: "/panchang" },
  { key: "horoscope", href: "/horoscope" },
  { key: "tools", href: "/tools" },
] as const;

export async function SiteHeader({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: "nav" });
  const other: Locale = locale === "en" ? "hi" : "en";
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          {BRAND_NAME}
        </Link>
        <nav aria-label={t("main")} className="order-3 w-full sm:order-2 sm:w-auto">
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {NAV.map((n) => (
              <li key={n.key}>
                <Link href={n.href} className="underline-offset-4 hover:underline">
                  {t(n.key)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <Link
          href="/"
          locale={other}
          hrefLang={other}
          className="order-2 rounded-sm border border-border px-3 py-1.5 text-sm hover:bg-surface sm:order-3"
        >
          {t("switchTo")}
        </Link>
      </div>
    </header>
  );
}
