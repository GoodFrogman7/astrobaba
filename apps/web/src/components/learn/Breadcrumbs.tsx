import type { Locale } from "@astro/shared";
import { getTranslations } from "next-intl/server";
import { JsonLd } from "@/components/JsonLd";
import { Link } from "@/i18n/navigation";
import { breadcrumbLd } from "@/lib/seo";

/** Visible breadcrumbs plus BreadcrumbList JSON-LD, starting at Home. */
export async function Breadcrumbs({
  locale,
  crumbs,
}: {
  locale: Locale;
  crumbs: { name: string; path: string }[];
}) {
  const t = await getTranslations({ locale, namespace: "shell" });
  const trail = [{ name: t("home"), path: "/" }, ...crumbs];
  return (
    <>
      <JsonLd data={breadcrumbLd(locale, trail)} />
      <nav aria-label={t("breadcrumbs")} className="text-sm text-muted">
        <ol className="flex flex-wrap gap-1">
          {trail.map((c, i) => (
            <li key={c.path} className="flex gap-1">
              {i > 0 && <span aria-hidden="true">/</span>}
              {i < trail.length - 1 ? (
                <Link href={c.path} className="underline-offset-2 hover:underline">
                  {c.name}
                </Link>
              ) : (
                <span aria-current="page">{c.name}</span>
              )}
            </li>
          ))}
        </ol>
      </nav>
    </>
  );
}
