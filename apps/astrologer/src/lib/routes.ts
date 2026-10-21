import { forward, json, SESSION_ID, wsUrl, type ForwardDeps } from "./forward";

/**
 * Cores of the console's route handlers (src/app/api/**). Each takes the session token and the
 * API location as data, so tests check auth forwarding and validation without Next.js.
 */

export interface RouteDeps extends ForwardDeps {
  wsBase: string;
}

const enc = encodeURIComponent;

export async function presenceRoute(body: unknown, deps: ForwardDeps): Promise<Response> {
  const status = (body as { status?: unknown } | null)?.status;
  if (status !== "online" && status !== "offline") return json({ code: "invalid_body" }, 400);
  return forward("POST", "/v1/astrologer/me/presence", deps, { status });
}

export function incomingRoute(deps: ForwardDeps): Promise<Response> {
  return forward("GET", "/v1/astrologer/me/sessions/incoming", deps);
}

export async function sessionRoute(id: string, deps: ForwardDeps): Promise<Response> {
  if (!SESSION_ID.test(id)) return json({ code: "not_found" }, 404);
  return forward("GET", `/v1/sessions/${enc(id)}`, deps);
}

export async function messagesRoute(
  id: string,
  params: URLSearchParams,
  deps: ForwardDeps,
): Promise<Response> {
  if (!SESSION_ID.test(id)) return json({ code: "not_found" }, 404);
  const after = params.get("after_seq") ?? "0";
  const limit = params.get("limit") ?? "200";
  if (
    !/^\d{1,9}$/.test(after) ||
    !/^\d{1,3}$/.test(limit) ||
    Number(limit) < 1 ||
    Number(limit) > 200
  ) {
    return json({ code: "invalid_query" }, 400);
  }
  const q = new URLSearchParams({ after_seq: String(Number(after)), limit: String(Number(limit)) });
  return forward("GET", `/v1/sessions/${enc(id)}/messages?${q}`, deps);
}

export const SESSION_ACTIONS = ["accept", "decline", "end", "ws-ticket"] as const;
export type SessionAction = (typeof SESSION_ACTIONS)[number];

export async function sessionActionRoute(
  id: string,
  action: string,
  deps: RouteDeps,
): Promise<Response> {
  if (!SESSION_ID.test(id) || !(SESSION_ACTIONS as readonly string[]).includes(action)) {
    return json({ code: "not_found" }, 404);
  }
  const res = await forward("POST", `/v1/sessions/${enc(id)}/${action}`, deps, {});
  if (action !== "ws-ticket" || !res.ok) return res;
  // The browser gets a ready-to-use socket URL; the ticket stays single-use and 30 s.
  const body = (await res.json()) as { ticket?: unknown; expires_in?: unknown; path?: unknown };
  const url =
    typeof body.ticket === "string" && typeof body.path === "string"
      ? wsUrl(deps.wsBase, body.path, body.ticket)
      : null;
  if (!url) return json({ code: "bad_upstream" }, 502);
  return json({ url, expires_in: body.expires_in ?? 30 });
}
