import { DEFAULT_LOCALE, LOCALES } from "@astro/shared";
import { defineRouting } from "next-intl/routing";

// English at "/", Hindi mirrored under "/hi".
export const routing = defineRouting({
  locales: LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: "as-needed",
  // Locale comes from the URL only, so every URL is one canonical, crawlable page.
  localeDetection: false,
});
