import citiesFile from "../../../../../data/seo/cities.json" with { type: "json" };

/**
 * Panchang cities: data/seo/cities.json (generated from the GeoNames index by
 * data/build_seo_cities.py), bundled at build time so pages and the sitemap always agree.
 */
export interface SeoCity {
  slug: string;
  geonameid: number;
  name_en: string;
  name_hi: string | null;
  lat: number;
  lon: number;
  tz: string;
  population: number;
}

export const DEFAULT_CITY_SLUG = "new-delhi";

export function seoCities(): SeoCity[] {
  return citiesFile.cities as SeoCity[];
}

/** City slugs for the sitemap; at least the default city. */
export function citySlugs(): string[] {
  const slugs = seoCities().map((c) => c.slug);
  return slugs.length ? slugs : [DEFAULT_CITY_SLUG];
}

export function findCity(slug: string): SeoCity | null {
  return seoCities().find((c) => c.slug === slug) ?? null;
}

export function cityName(c: SeoCity, locale: "en" | "hi"): string {
  return locale === "hi" ? (c.name_hi ?? c.name_en) : c.name_en;
}
