import type { Locale } from "@astro/shared";

export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(
  /\/$/,
  "",
);

/** Absolute URL for a path in a locale (English unprefixed, Hindi under /hi). */
export function localeUrl(locale: Locale, path = "/"): string {
  const clean = path === "/" ? "" : path;
  return locale === "en" ? `${SITE_URL}${clean || "/"}` : `${SITE_URL}/${locale}${clean}`;
}
