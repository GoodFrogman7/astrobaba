import type { MetadataRoute } from "next";

/** The console is a private working tool: nothing here is for search engines. */
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: "*", disallow: "/" }] };
}
