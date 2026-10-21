import { TOOLS } from "@/lib/tools/registry";
import type { SiteRoute } from "./index";

/** Tool, kundli and matchmaking pages (owned by the tools work). */
export function toolRoutes(): SiteRoute[] {
  return [
    { path: "/kundli", changeFrequency: "monthly", priority: 0.9 },
    { path: "/kundli-matching", changeFrequency: "monthly", priority: 0.9 },
    { path: "/tools", changeFrequency: "monthly", priority: 0.8 },
    ...TOOLS.map((t) => ({
      path: `/tools/${t.slug}`,
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
  ];
}
