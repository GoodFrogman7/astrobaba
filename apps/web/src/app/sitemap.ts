import { LOCALES } from "@astro/shared";
import type { MetadataRoute } from "next";
import { siteRoutes } from "@/lib/routes";
import { localeUrl } from "@/site";

export default function sitemap(): MetadataRoute.Sitemap {
  return siteRoutes().flatMap((r) =>
    LOCALES.map((locale) => ({
      url: localeUrl(locale, r.path),
      changeFrequency: r.changeFrequency,
      priority: r.priority,
      alternates: { languages: Object.fromEntries(LOCALES.map((l) => [l, localeUrl(l, r.path)])) },
    })),
  );
}
