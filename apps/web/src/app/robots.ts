import type { MetadataRoute } from "next";
import { isProductionSite } from "@/lib/publishing";
import { SITE_URL } from "@/site";

/**
 * Production: crawl everything public. Any other NEXT_PUBLIC_SITE_ENV (staging, previews, local
 * builds): disallow everything; next.config.ts also sends `X-Robots-Tag: noindex` on every
 * response there (docs/api/growth.md §3).
 */
export default function robots(): MetadataRoute.Robots {
  if (!isProductionSite())
    return { rules: [{ userAgent: "*", disallow: "/" }], sitemap: `${SITE_URL}/sitemap.xml` };
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/api/", "/dev/", "/hi/dev/", "/print/"] }],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
