import { BRAND_NAME, DISCLAIMER, flagEnabled, type Locale } from "@astro/shared";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { NAV } from "./SiteHeader";

export async function SiteFooter({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: "footer" });
  const tn = await getTranslations({ locale, namespace: "nav" });
  const tl = await getTranslations({ locale, namespace: "revenue.links" });
  // Read when the footer renders (build/revalidate time for static pages), like the /ai page's
  // own check, so there is no AI link anywhere while the flag is off.
  const extra = [
    { key: "remedies", href: "/remedies" },
    { key: "myReports", href: "/account/reports" },
    ...(flagEnabled("ai_assistant") ? [{ key: "ai", href: "/ai" }] : []),
  ];
  return (
    <footer className="mt-16 border-t border-border">
      <div className="mx-auto max-w-5xl space-y-3 px-4 py-8 text-sm text-muted">
        <ul className="flex flex-wrap gap-x-4">
          {NAV.map((n) => (
            <li key={n.key}>
              <Link href={n.href} className="inline-block py-1.5 hover:underline">
                {tn(n.key)}
              </Link>
            </li>
          ))}
          {extra.map((n) => (
            <li key={n.key}>
              <Link href={n.href} className="inline-block py-1.5 hover:underline">
                {tl(n.key)}
              </Link>
            </li>
          ))}
        </ul>
        <p data-testid="disclaimer">{DISCLAIMER[locale]}</p>
        <p>{t("dataCredits")}</p>
        <p>{t("rights", { year: new Date().getUTCFullYear(), brand: BRAND_NAME })}</p>
      </div>
    </footer>
  );
}
