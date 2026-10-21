/**
 * Route-handler plumbing: the browser talks only to this app; this app adds the httpOnly session
 * token as a Bearer header and forwards to the core API. Pure (fetch is injected) for tests.
 */

export interface ForwardDeps {
  token: string | undefined;
  apiUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const NO_STORE = { "cache-control": "no-store, max-age=0" };

/** Session ids are opaque but short and URL-safe; anything else never reaches the API. */
export const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...NO_STORE },
  });
}

export async function forward(
  method: "GET" | "POST",
  path: string,
  deps: ForwardDeps,
  body?: unknown,
): Promise<Response> {
  if (!deps.token) return json({ code: "signed_out" }, 401);
  const doFetch = deps.fetchImpl ?? fetch;
  let upstream: Response;
  try {
    upstream = await doFetch(deps.apiUrl + path, {
      method,
      cache: "no-store",
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10000),
      headers: {
        authorization: `Bearer ${deps.token}`,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    return json({ code: "api_unavailable" }, 503);
  }
  // Only the status and JSON body go back to the browser: never upstream cookies or headers.
  const text = await upstream.text();
  if (upstream.status === 204 || !text)
    return new Response(null, { status: upstream.status, headers: NO_STORE });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return json({ code: "bad_upstream" }, 502);
  }
  return json(errorShape(parsed, upstream.ok), upstream.status);
}

/** API errors are `{detail: {code, message}}`; the browser gets `{code, message, ...extra}`. */
function errorShape(body: unknown, ok: boolean): unknown {
  if (ok || !body || typeof body !== "object") return body;
  const d = (body as { detail?: unknown }).detail;
  if (d && typeof d === "object" && !Array.isArray(d)) return d;
  return { code: "api_error" };
}

/**
 * The API answers the ticket call with a path; the browser connects to the API's WebSocket
 * origin. Only `/v1/sessions/…/ws` paths are accepted.
 */
export function wsUrl(base: string, path: string, ticket: string): string | null {
  if (!/^\/v1\/sessions\/[A-Za-z0-9_-]{1,64}\/ws$/.test(path)) return null;
  const origin = base.replace(/\/$/, "");
  if (!/^wss?:\/\//.test(origin)) return null;
  return `${origin}${path}?ticket=${encodeURIComponent(ticket)}`;
}

/** WebSocket origin of the API, read at request time so Docker images need no rebuild. */
export function wsBase(env: Record<string, string | undefined>): string {
  return (env.API_WS_URL || env.NEXT_PUBLIC_API_WS_URL || "ws://localhost:8000").replace(/\/$/, "");
}
