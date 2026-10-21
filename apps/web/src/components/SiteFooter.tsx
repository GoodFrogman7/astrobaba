import { BRAND_NAME, DISCLAIMER, type Locale } from "@astro/shared";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { NAV } from "./SiteHeader";

export async function SiteFooter({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: "footer" });
  const tn = await getTranslations({ locale, namespace: "nav" });
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
        </ul>
        <p data-testid="disclaimer">{DISCLAIMER[locale]}</p>
        <p>{t("dataCredits")}</p>
        <p>{t("rights", { year: new Date().getUTCFullYear(), brand: BRAND_NAME })}</p>
      </div>
    </footer>
  );
}
