import { LEGAL_PAGES, LEGAL_PATHS } from "@/lib/trust/pages";
import type { SiteRoute } from "./index";

/**
 * Phase 7 policy pages: public, indexable and in the sitemap, so people can find the terms,
 * the privacy notice and the crisis resources before they sign up. While a version is a draft
 * each page says so at the top. /account is personal and never listed.
 */
export function legalRoutes(): SiteRoute[] {
  return LEGAL_PAGES.map((k) => ({
    path: LEGAL_PATHS[k],
    changeFrequency: "monthly" as const,
    priority: k === "safety" ? 0.5 : 0.3,
  }));
}
