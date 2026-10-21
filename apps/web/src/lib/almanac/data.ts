import "server-only";

import { cache } from "react";
import { api, astro, cachedForDay, UpstreamError } from "@/lib/upstream";
import { DEFAULT_CITY_SLUG, findCity, type SeoCity } from "./cities";
import { istDays } from "./dates";
import type { HoroscopeFacts, Panchang, PublishedHoroscope } from "./types";

/** One IST "today" per request: title, meta description and body all read this value. */
export const requestIstDays = cache(() => istDays(new Date()));

/** A panchang city by slug; New Delhi resolves through the engine if the curated list is absent. */
export async function getCity(slug: string): Promise<SeoCity | null> {
  const found = findCity(slug);
  if (found || slug !== DEFAULT_CITY_SLUG) return found;
  type Result = {
    results: {
      id: number;
      name: string;
      lat: number;
      lon: number;
      tz: string;
      population: number;
    }[];
  };
  const r = await astro.get<Result>("/v1/cities?q=new%20delhi&country=IN&limit=1");
  const c = r.results[0];
  return c
    ? {
        slug,
        geonameid: c.id,
        name_en: c.name,
        name_hi: null,
        lat: c.lat,
        lon: c.lon,
        tz: c.tz,
        population: c.population,
      }
    : null;
}

export async function loadPanchang(city: SeoCity, date: string): Promise<Panchang> {
  const { today } = requestIstDays();
  const q = new URLSearchParams({
    lat: String(city.lat),
    lon: String(city.lon),
    tz: city.tz,
    date,
  });
  return cachedForDay(`panchang:${city.slug}:${date}`, today, () =>
    astro.get<Panchang>(`/v1/panchang?${q}`),
  );
}

export async function loadFacts(
  sign: string,
  period: string,
  date: string,
): Promise<HoroscopeFacts> {
  const { today } = requestIstDays();
  const q = new URLSearchParams({ sign, period, date });
  return cachedForDay(`facts:${sign}:${period}:${date}`, today, () =>
    astro.get<HoroscopeFacts>(`/v1/horoscope/facts?${q}`),
  );
}

/** Reviewed prose from the QA queue, or null when nothing is published (or the API is down). */
export async function loadPublished(
  period: string,
  sign: string,
  date: string,
  locale: string,
): Promise<PublishedHoroscope | null> {
  const q = new URLSearchParams({ date, locale });
  try {
    return await api.get<PublishedHoroscope>(`/v1/horoscopes/${period}/${sign}?${q}`);
  } catch (e) {
    if (e instanceof UpstreamError) return null;
    throw e;
  }
}
