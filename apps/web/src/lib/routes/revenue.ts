import type { SiteRoute } from "./index";

/**
 * Phase 6 public pages (docs/api/revenue.md). /reports is indexable. /remedies is public but
 * noindex until its catalogue passes editorial and legal review (REMEDIES_INDEXABLE), so it is
 * listed here only once it is indexable. /account/* and /ai are personal and never listed.
 */
export function revenueRoutes({ remedies = false }: { remedies?: boolean } = {}): SiteRoute[] {
  return [
    { path: "/reports", changeFrequency: "weekly", priority: 0.8 },
    ...(remedies ? [{ path: "/remedies", changeFrequency: "weekly" as const, priority: 0.5 }] : []),
  ];
}
