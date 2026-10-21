import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { deviceId, sessionToken, setDevice } from "@/lib/tools/proxy";
import { IDEMPOTENCY_KEY } from "./idempotency";

const API_URL = (process.env.API_URL ?? "http://localhost:8000").replace(/\/$/, "");

/** Ids in our paths (sessions, orders): opaque, short, URL-safe. */
export const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The visitor's IP for the API's abuse heuristics (free first session): the right-most
 * X-Forwarded-For entry, i.e. the one our own load balancer appended (left-most entries are
 * client-controlled), else X-Real-IP. Undefined when there is no proxy in front (local dev).
 */
export function clientIp(headers: Headers): string | undefined {
  const xff = headers.get("x-forwarded-for");
  const last = xff
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .pop();
  const ip = last ?? headers.get("x-real-ip")?.trim();
  return ip && /^[0-9a-fA-F:.]{2,45}$/.test(ip) ? ip : undefined;
}

export interface ForwardOptions {
  method: "GET" | "POST";
  /** API path including any query string. */
  path: string;
  body?: unknown;
}

/**
 * Forward a signed-in user's request to the API: Bearer token from the httpOnly session cookie,
 * device id as X-Device-Id, the client IP, and the browser's Idempotency-Key unchanged. Only
 * status and JSON body come back; upstream headers are not relayed, so the token never reaches
 * page scripts. Nothing here logs bodies (chat text, amounts tied to people).
 */
export async function forward(req: NextRequest, opts: ForwardOptions): Promise<NextResponse> {
  const token = await sessionToken();
  if (!token) return NextResponse.json({ code: "not_signed_in" }, { status: 401 });
  const idem = req.headers.get("idempotency-key");
  if (idem !== null && !IDEMPOTENCY_KEY.test(idem))
    return NextResponse.json({ code: "invalid_idempotency_key" }, { status: 400 });
  const device = await deviceId();
  const ip = clientIp(req.headers);
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "x-device-id": device.id,
    ...(ip ? { "x-forwarded-for": ip } : {}),
    ...(idem ? { "idempotency-key": idem } : {}),
    ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
  };
  let res: NextResponse;
  try {
    const upstream = await fetch(API_URL + opts.path, {
      method: opts.method,
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    res = await relay(upstream);
  } catch {
    res = NextResponse.json({ code: "upstream_unavailable" }, { status: 503 });
  }
  if (device.isNew) setDevice(res, req, device.id);
  return res;
}

/**
 * Status and JSON body. Errors are flattened from `{"detail": {code, message, ...extra}}` (and
 * any top-level extras) to `{code, message, ...extra}` so the UI can read e.g.
 * `minutes_affordable` or `session_id` without knowing where the API put them.
 */
export async function relay(res: Response): Promise<NextResponse> {
  if (res.status === 204) return new NextResponse(null, { status: 204 });
  let json: unknown = {};
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  if (res.ok) return NextResponse.json(json, { status: res.status });
  const obj = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const { detail, ...top } = obj;
  const d = detail && typeof detail === "object" ? (detail as Record<string, unknown>) : {};
  const code = typeof d.code === "string" ? d.code : "upstream_error";
  return NextResponse.json({ ...top, ...d, code }, { status: res.status });
}

/** Parse a JSON body; null when it is missing or not JSON. */
export async function readJson(req: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const body = (await req.json()) as unknown;
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export const invalidBody = () => NextResponse.json({ code: "invalid_body" }, { status: 400 });
export const notFound = () => NextResponse.json({ code: "not_found" }, { status: 404 });
