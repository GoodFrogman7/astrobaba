import { AVAILABILITY_LIMITS } from "@astro/shared";
import { errorBody, forward, json, NO_STORE, OPAQUE_ID, type ForwardDeps } from "./forward";
import { REPLY_MAX_CHARS } from "./reviews";
import { CONSENT_VERSION, TERMS_KIND } from "./trust";

/**
 * Route-handler cores for the portal (docs/api/portal.md §2). Only the calls the browser needs
 * are exposed: saving the schedule, the consultation toggles, replying to a review and
 * downloading a statement. Pages read everything else server-side. Bodies are rebuilt from the
 * expected fields only, so nothing else ever reaches the API from the browser.
 */

const enc = encodeURIComponent;

const HHMM = /^\d{2}:\d{2}$/;

/** `PUT /v1/astrologer/me/availability {slots}`. Shape only; the API validates the rules. */
export async function availabilityRoute(body: unknown, deps: ForwardDeps): Promise<Response> {
  const slots = (body as { slots?: unknown } | null)?.slots;
  if (!Array.isArray(slots) || slots.length > AVAILABILITY_LIMITS.maxSlots) {
    return json({ code: "invalid_body" }, 400);
  }
  const clean: { weekday: number; start: string; end: string }[] = [];
  for (const s of slots) {
    const o = (s ?? {}) as { weekday?: unknown; start?: unknown; end?: unknown };
    if (
      typeof o.weekday !== "number" ||
      !Number.isInteger(o.weekday) ||
      o.weekday < 0 ||
      o.weekday > 6 ||
      typeof o.start !== "string" ||
      typeof o.end !== "string" ||
      !HHMM.test(o.start) ||
      !HHMM.test(o.end)
    ) {
      return json({ code: "invalid_body" }, 400);
    }
    clean.push({ weekday: o.weekday, start: o.start, end: o.end });
  }
  return forward("PUT", "/v1/astrologer/me/availability", deps, { slots: clean });
}

/** `PATCH /v1/astrologer/me/consult {chat_enabled?, call_enabled?}`: booleans only. */
export async function consultRoute(body: unknown, deps: ForwardDeps): Promise<Response> {
  const b = (body ?? {}) as { chat_enabled?: unknown; call_enabled?: unknown };
  const patch: { chat_enabled?: boolean; call_enabled?: boolean } = {};
  for (const k of ["chat_enabled", "call_enabled"] as const) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== "boolean") return json({ code: "invalid_body" }, 400);
    patch[k] = b[k];
  }
  if (Object.keys(patch).length === 0) return json({ code: "invalid_body" }, 400);
  return forward("PATCH", "/v1/astrologer/me/consult", deps, patch);
}

/** `POST /v1/reviews/{id}/reply {text}` (once; the API moderates it). */
export async function reviewReplyRoute(
  id: string,
  body: unknown,
  deps: ForwardDeps,
): Promise<Response> {
  if (!OPAQUE_ID.test(id)) return json({ code: "not_found" }, 404);
  const text = (body as { text?: unknown } | null)?.text;
  if (typeof text !== "string") return json({ code: "invalid_body" }, 400);
  const trimmed = text.trim();
  if (!trimmed) return json({ code: "empty_reply" }, 400);
  if (trimmed.length > REPLY_MAX_CHARS) return json({ code: "text_too_long" }, 422);
  return forward("POST", `/v1/reviews/${enc(id)}/reply`, deps, { text: trimmed });
}

/**
 * `GET /v1/astrologer/me/payouts/{id}/statement.csv`, streamed through. Only `content-type`
 * (must be CSV) and `content-disposition` (must be an attachment) are passed on; every other
 * upstream header (cookies, server details) is dropped, and the file is never cached.
 */
export async function statementCsvRoute(id: string, deps: ForwardDeps): Promise<Response> {
  if (!OPAQUE_ID.test(id)) return json({ code: "not_found" }, 404);
  if (!deps.token) return json({ code: "signed_out" }, 401);
  const doFetch = deps.fetchImpl ?? fetch;
  let upstream: Response;
  try {
    upstream = await doFetch(`${deps.apiUrl}/v1/astrologer/me/payouts/${enc(id)}/statement.csv`, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(deps.timeoutMs ?? 30000),
      headers: { authorization: `Bearer ${deps.token}`, accept: "text/csv" },
    });
  } catch {
    return json({ code: "api_unavailable" }, 503);
  }
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return json(errorBody(parsed), upstream.status);
  }
  const type = upstream.headers.get("content-type") ?? "";
  if (!/^text\/csv\b/i.test(type) || !upstream.body) {
    await upstream.body?.cancel().catch(() => undefined);
    return json({ code: "bad_upstream" }, 502);
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": type,
      "content-disposition": safeDisposition(upstream.headers.get("content-disposition"), id),
      ...NO_STORE,
    },
  });
}

/** Keep the API's attachment header when it is a plain attachment; otherwise name it ourselves. */
export function safeDisposition(value: string | null, id: string): string {
  if (value && /^attachment\s*(;|$)/i.test(value) && !/[\u0000-\u001f\u007f]/.test(value)) {
    return value;
  }
  return `attachment; filename="statement-${id.replace(/[^A-Za-z0-9_-]/g, "")}.csv"`;
}

/**
 * `POST /v1/me/consents {version, kinds: ["astrologer_terms"]}` (trust.md §1). The portal only
 * ever accepts the astrologer terms, so the kind is fixed here and only the version comes from
 * the browser.
 */
export async function consentRoute(body: unknown, deps: ForwardDeps): Promise<Response> {
  const version = (body as { version?: unknown } | null)?.version;
  if (typeof version !== "string" || !CONSENT_VERSION.test(version)) {
    return json({ code: "invalid_body" }, 400);
  }
  return forward("POST", "/v1/me/consents", deps, { version, kinds: [TERMS_KIND] });
}

/** `GET /v1/safety/resources` (public): crisis helplines for the safety panel in a session. */
export function safetyResourcesRoute(deps: ForwardDeps): Promise<Response> {
  return forward("GET", "/v1/safety/resources", deps);
}
