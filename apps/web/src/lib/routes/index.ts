import { toolRoutes } from "./tools";
import { almanacRoutes } from "./almanac";
import { astrologerRoutes } from "./astrologers";
import { revenueRoutes } from "./revenue";
import { REMEDIES_INDEXABLE } from "@/lib/revenue/config";

/** One indexable page, identical path in every locale (Hindi adds the /hi prefix). */
export interface SiteRoute {
  path: string;
  changeFrequency: "daily" | "weekly" | "monthly";
  priority: number;
}

const coreRoutes: SiteRoute[] = [{ path: "/", changeFrequency: "daily", priority: 1 }];

/**
 * Static sitemap routes; the SEO check fetches each one in both locales. Astrologer profiles are
 * added at request time (see app/sitemap.ts).
 */
export function siteRoutes(): SiteRoute[] {
  return [
    ...coreRoutes,
    ...toolRoutes(),
    ...almanacRoutes(),
    ...astrologerRoutes(),
    ...revenueRoutes({ remedies: REMEDIES_INDEXABLE }),
  ];
}
