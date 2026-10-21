import "server-only";

import { api, API_URL, UpstreamError } from "@/lib/upstream";
import { type Filters, toApiQuery } from "./filters";
import type { AstrologerCard, AstrologerProfile, ListResponse, ReviewsResponse } from "./types";

export type Loaded<T> = { ok: true; data: T } | { ok: false; status: number; code: string };

async function load<T>(fn: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (e instanceof UpstreamError) return { ok: false, status: e.status, code: e.code };
    return { ok: false, status: 500, code: "unexpected_error" };
  }
}

/** Cards per directory page: small enough to keep the page light on phones; "Load more" follows. */
export const DIRECTORY_PAGE_SIZE = 12;

export function listAstrologers(f: Filters, cursor: string | null): Promise<Loaded<ListResponse>> {
  return load(() =>
    api.get<ListResponse>(`/v1/astrologers?${toApiQuery(f, cursor, DIRECTORY_PAGE_SIZE)}`),
  );
}

export function getProfile(slug: string): Promise<Loaded<AstrologerProfile>> {
  return load(() => api.get<AstrologerProfile>(`/v1/astrologers/${encodeURIComponent(slug)}`));
}

export function getReviews(slug: string, cursor: string | null): Promise<Loaded<ReviewsResponse>> {
  const q = new URLSearchParams({ limit: "10" });
  if (cursor) q.set("cursor", cursor);
  return load(() =>
    api.get<ReviewsResponse>(`/v1/astrologers/${encodeURIComponent(slug)}/reviews?${q}`),
  );
}

/**
 * Up to three public astrologers for the call-to-action on every page. Cached for five minutes
 * so static pages stay static (ISR); presence is deliberately not shown from this cached data.
 */
export async function featuredAstrologers(): Promise<AstrologerCard[]> {
  try {
    const res = await fetch(`${API_URL}/v1/astrologers?sort=recommended&limit=3`, {
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return [];
    return ((await res.json()) as ListResponse).items.slice(0, 3);
  } catch {
    return [];
  }
}

/** Public profile slugs for the sitemap, without demo profiles. Empty when the API is down. */
export async function sitemapSlugs(): Promise<{ slug: string; updated_at?: string }[]> {
  try {
    const slugs =
      await api.get<{ slug: string; updated_at?: string; is_demo?: boolean }[]>(
        "/v1/astrologers/slugs",
      );
    const demo = new Set<string>();
    if (!slugs.some((s) => "is_demo" in s)) {
      // The slugs endpoint does not say which rows are demo (dev only); read the directory.
      let cursor: string | null = null;
      for (let page = 0; page < 20; page++) {
        const q = new URLSearchParams({ sort: "recommended", limit: "50" });
        if (cursor) q.set("cursor", cursor);
        const list: ListResponse = await api.get<ListResponse>(`/v1/astrologers?${q}`);
        for (const a of list.items) if (a.is_demo) demo.add(a.slug);
        cursor = list.next_cursor;
        if (!cursor) break;
      }
    }
    return slugs.filter((s) => !s.is_demo && !demo.has(s.slug));
  } catch {
    return [];
  }
}
