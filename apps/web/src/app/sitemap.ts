import { LOCALES } from "@astro/shared";
import type { MetadataRoute } from "next";
import { learnSource } from "@/lib/learn";
import { sitemapSlugs } from "@/lib/marketplace/data";
import { siteRoutes } from "@/lib/routes";
import { learnRoutes } from "@/lib/routes/learn";
import { localeUrl } from "@/site";

// Astrologer profiles change as people are approved or suspended, so build on each request.
// If the API is down the static routes are still listed.
export const dynamic = "force-dynamic";

interface Entry {
  path: string;
  changeFrequency: "daily" | "weekly" | "monthly";
  priority: number;
  lastModified?: string;
  /** Locales the path exists in (default: all). */
  locales?: readonly (typeof LOCALES)[number][];
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const profiles: Entry[] = (await sitemapSlugs()).map((s) => ({
    path: `/astrologers/${s.slug}`,
    changeFrequency: "weekly",
    priority: 0.6,
    lastModified: s.updated_at,
  }));
  // Published, reviewed /learn articles only (docs/api/growth.md §3).
  const learn: Entry[] = learnRoutes(learnSource(), LOCALES);
  const entries: Entry[] = [...siteRoutes(), ...profiles, ...learn];
  return entries.flatMap((r) => {
    const locales = r.locales ?? LOCALES;
    return locales.map((locale) => ({
      url: localeUrl(locale, r.path),
      changeFrequency: r.changeFrequency,
      priority: r.priority,
      ...(r.lastModified ? { lastModified: r.lastModified } : {}),
      alternates: {
        languages: Object.fromEntries(locales.map((l) => [l, localeUrl(l, r.path)])),
      },
    }));
  });
}
