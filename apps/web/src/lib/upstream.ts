import "server-only";

/**
 * Server-side clients for the astro engine and the core API. Never imported by client
 * components, so service URLs and birth details stay on the server.
 */
const ASTRO_URL = (process.env.ASTRO_URL ?? "http://localhost:8001").replace(/\/$/, "");
const API_URL = (process.env.API_URL ?? "http://localhost:8000").replace(/\/$/, "");

export class UpstreamError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(base: string, path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(base + path, {
      ...init,
      cache: "no-store",
      signal: init.signal ?? AbortSignal.timeout(8000),
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
  } catch {
    throw new UpstreamError(503, "upstream_unavailable", `${base} unreachable`);
  }
  if (!res.ok) {
    let code = "upstream_error";
    let message = res.statusText;
    try {
      const body = (await res.json()) as { detail?: { code?: string; message?: string } | string };
      if (typeof body.detail === "object" && body.detail) {
        code = body.detail.code ?? code;
        message = body.detail.message ?? message;
      }
    } catch {
      /* not JSON */
    }
    throw new UpstreamError(res.status, code, message);
  }
  return (await res.json()) as T;
}

export const astro = {
  get: <T>(path: string) => call<T>(ASTRO_URL, path),
  post: <T>(path: string, body: unknown) =>
    call<T>(ASTRO_URL, path, { method: "POST", body: JSON.stringify(body) }),
};

export const api = {
  get: <T>(path: string, token?: string) =>
    call<T>(API_URL, path, { headers: token ? { authorization: `Bearer ${token}` } : {} }),
  post: <T>(path: string, body: unknown, token?: string) =>
    call<T>(API_URL, path, {
      method: "POST",
      body: JSON.stringify(body),
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
  delete: <T>(path: string, token?: string) =>
    call<T>(API_URL, path, {
      method: "DELETE",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
};

/**
 * Small in-process cache for day-scoped data (panchang, horoscope facts). The IST date is part
 * of the key, so entries roll over at 00:00 IST by construction (PLAN.md §5 Phase 2: revalidate
 * at 00:00 IST) and a "today" page can never show yesterday's data.
 */
const dayCache = new Map<string, unknown>();
const DAY_CACHE_MAX = 2000;

export async function cachedForDay<T>(
  key: string,
  istDate: string,
  load: () => Promise<T>,
): Promise<T> {
  const k = `${istDate}|${key}`;
  const hit = dayCache.get(k);
  if (hit !== undefined) return hit as T;
  const value = await load();
  if (dayCache.size >= DAY_CACHE_MAX) dayCache.clear();
  dayCache.set(k, value);
  return value;
}
