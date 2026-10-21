import type { Locale } from "@astro/shared";
import type { ArticleSource } from "@/lib/learn";
import type { SiteRoute } from "./index";

/**
 * /learn in the sitemap (docs/api/growth.md §3): each published article in the locales it is
 * published in, and the /learn list in each locale that has at least one. Unlike siteRoutes(),
 * a path may exist in only one locale, so each entry carries its own locales.
 */
export interface LocalizedRoute extends SiteRoute {
  locales: Locale[];
  lastModified?: string;
}

export function learnRoutes(source: ArticleSource, locales: readonly Locale[]): LocalizedRoute[] {
  const byLocale = new Map(locales.map((l) => [l, source.list(l)] as const));
  const out: LocalizedRoute[] = [];
  const hubLocales = locales.filter((l) => (byLocale.get(l) ?? []).length > 0);
  if (hubLocales.length) {
    const latest = hubLocales
      .flatMap((l) => byLocale.get(l) ?? [])
      .map((a) => a.updated_at)
      .sort()
      .pop();
    out.push({
      path: "/learn",
      changeFrequency: "weekly",
      priority: 0.6,
      locales: hubLocales,
      ...(latest ? { lastModified: latest } : {}),
    });
  }
  const slugs = [...new Set(hubLocales.flatMap((l) => (byLocale.get(l) ?? []).map((a) => a.slug)))];
  for (const slug of slugs.sort()) {
    const present = locales.filter((l) => (byLocale.get(l) ?? []).some((a) => a.slug === slug));
    const updated = present
      .map((l) => byLocale.get(l)?.find((a) => a.slug === slug)?.updated_at ?? "")
      .sort()
      .pop();
    out.push({
      path: `/learn/${slug}`,
      changeFrequency: "monthly",
      priority: 0.6,
      locales: present,
      ...(updated ? { lastModified: updated } : {}),
    });
  }
  return out;
}
