import { citySlugs } from "@/lib/almanac/cities";
import { PERIODS, SIGN_IDS } from "@/lib/almanac/names";
import type { SiteRoute } from "./index";

/** Panchang and horoscope pages (owned by the almanac work). Dated panchang URLs stay out. */
export function almanacRoutes(): SiteRoute[] {
  return [
    { path: "/panchang", changeFrequency: "daily", priority: 0.9 },
    ...citySlugs().flatMap((slug): SiteRoute[] => [
      { path: `/panchang/${slug}`, changeFrequency: "daily", priority: 0.8 },
      { path: `/panchang/${slug}/tomorrow`, changeFrequency: "daily", priority: 0.6 },
    ]),
    { path: "/horoscope", changeFrequency: "weekly", priority: 0.9 },
    ...PERIODS.flatMap((period) =>
      SIGN_IDS.map((sign): SiteRoute => ({
        path: `/horoscope/${period}/${sign}`,
        changeFrequency: period === "monthly" ? "weekly" : "daily",
        priority: 0.7,
      })),
    ),
  ];
}
