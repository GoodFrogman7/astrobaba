import type { SiteRoute } from "./index";

/** Directory and apply landing. Profiles are added at request time by app/sitemap.ts. */
export function astrologerRoutes(): SiteRoute[] {
  return [
    { path: "/astrologers", changeFrequency: "daily", priority: 0.9 },
    { path: "/astrologers/apply", changeFrequency: "monthly", priority: 0.4 },
  ];
}
