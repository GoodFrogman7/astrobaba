import "server-only";

import {
  ANALYTICS_SCHEMA_VERSION,
  isLocale,
  validateEvent,
  type AnalyticsEvent,
  type Locale,
} from "@astro/shared";
import type { NextRequest, NextResponse } from "next/server";
import { clientIp } from "@/lib/billing/forward";
import { isHttps, SESSION_COOKIE } from "@/lib/tools/cookies";
import { API_URL } from "@/lib/upstream";
import { AID_COOKIE, AID_MAX_AGE_S, MAX_BATCH, OPT_OUT_COOKIE, OPT_OUT_MAX_AGE_S } from "./config";

/**
 * Server side of the first-party analytics (docs/api/growth.md §1.1): the /api/e collector,
 * the opt-out switch and the server-side otp_verified event. Nothing here logs request bodies,
 * user agents or IPs; the user agent is only matched against the bot pattern, never forwarded.
 */

/** Crawlers, link previews, monitoring, headless browsers and HTTP libraries. */
export const BOT_UA =
  /bot\b|bot\/|crawl|spider|slurp|archiver|facebookexternalhit|embedly|quora link preview|bingpreview|whatsapp\/|telegrambot|lighthouse|pagespeed|headless|phantomjs|puppeteer|playwright|selenium|curl\/|wget\/|python|httpclient|okhttp|axios|node-fetch|undici|go-http-client|java\/|libwww|scrapy|^node$/i;

export function isBot(userAgent: string | null): boolean {
  return !userAgent || BOT_UA.test(userAgent.trim());
}

/** Sec-GPC: 1, DNT: 1 or the privacy page switch (aid_off=1). */
export function optedOut(req: NextRequest): boolean {
  return (
    req.headers.get("sec-gpc")?.trim() === "1" ||
    req.headers.get("dnt")?.trim() === "1" ||
    req.cookies.get(OPT_OUT_COOKIE)?.value === "1"
  );
}

/** The `aid` value: 16 random bytes, base64url without padding (22 characters). */
export const AID_RE = /^[A-Za-z0-9_-]{22}$/;

export function newAnonymousId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Buffer.from(bytes).toString("base64url");
}

export function existingAid(req: NextRequest): string | null {
  const v = req.cookies.get(AID_COOKIE)?.value;
  return v && AID_RE.test(v) ? v : null;
}

const secure = (req: NextRequest) => isHttps(req.url, req.headers.get("x-forwarded-proto"));

export function setAid(res: NextResponse, req: NextRequest, aid: string) {
  res.cookies.set(AID_COOKIE, aid, {
    httpOnly: true,
    secure: secure(req),
    sameSite: "lax",
    path: "/",
    maxAge: AID_MAX_AGE_S,
  });
}

export function clearAid(res: NextResponse, req: NextRequest) {
  res.cookies.set(AID_COOKIE, "", {
    httpOnly: true,
    secure: secure(req),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

/** aid_off is readable by page scripts on purpose: it holds no identifier, only the choice. */
export function setOptOut(res: NextResponse, req: NextRequest, on: boolean) {
  res.cookies.set(OPT_OUT_COOKIE, on ? "1" : "", {
    httpOnly: false,
    secure: secure(req),
    sameSite: "lax",
    path: "/",
    maxAge: on ? OPT_OUT_MAX_AGE_S : 0,
  });
}

/**
 * Envelopes for the API from the browser's `{events: [{event, ts, locale, properties}]}`.
 * Only those four fields are read; anonymous_id, user_id (always null: the API takes the user
 * from the bearer token) and schema_version are filled here. Events the shared validator
 * rejects are dropped. null when the body itself is malformed or has more than 20 events.
 */
export function buildEnvelopes(body: unknown, anonymousId: string): AnalyticsEvent[] | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const events = (body as { events?: unknown }).events;
  if (!Array.isArray(events) || events.length > MAX_BATCH) return null;
  const out: AnalyticsEvent[] = [];
  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    const r = validateEvent({
      event: e.event,
      ts: e.ts,
      locale: e.locale,
      properties: e.properties,
      anonymous_id: anonymousId,
      user_id: null,
      schema_version: ANALYTICS_SCHEMA_VERSION,
    });
    if (r.ok) out.push(r.event);
  }
  return out;
}

/**
 * POST /v1/analytics/events with the signed-in user's bearer token (if any) and the client IP
 * the API rate-limits on. Resolves to false on any failure; never throws.
 */
export async function postEvents(
  events: AnalyticsEvent[],
  { token, ip, timeoutMs = 2500 }: { token?: string; ip?: string; timeoutMs?: number },
): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/v1/analytics/events`, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(ip ? { "x-forwarded-for": ip } : {}),
      },
      body: JSON.stringify({ events }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function sessionTokenOf(req: NextRequest): string | undefined {
  return req.cookies.get(SESSION_COOKIE)?.value || undefined;
}

/** The page the request came from: /hi or /hi/... is Hindi, anything else English. */
export function localeFromReferer(referer: string | null): Locale {
  if (!referer) return "en";
  try {
    const first = new URL(referer).pathname.split("/")[1] ?? "";
    return isLocale(first) ? first : "en";
  } catch {
    return "en";
  }
}

/**
 * Identity link after a successful OTP verify (docs/api/growth.md §1.1): otp_verified with the
 * new token and the visitor's `aid`, so the API links the anonymous id to the user. Skipped
 * without an `aid` or with an opt-out. Fire-and-forget with a short timeout: the returned
 * promise never rejects, and callers do not await it, so sign-in never waits on or fails
 * because of analytics.
 */
export function sendOtpVerified(
  req: NextRequest,
  token: string,
  isNewUser: boolean,
): Promise<boolean> {
  try {
    const aid = existingAid(req);
    if (!aid || optedOut(req)) return Promise.resolve(false);
    const event: AnalyticsEvent = {
      event: "otp_verified",
      ts: new Date().toISOString(),
      anonymous_id: aid,
      user_id: null,
      locale: localeFromReferer(req.headers.get("referer")),
      schema_version: ANALYTICS_SCHEMA_VERSION,
      properties: { is_new_user: isNewUser },
    };
    if (!validateEvent(event).ok) return Promise.resolve(false);
    return postEvents([event], { token, ip: clientIp(req.headers), timeoutMs: 1500 });
  } catch {
    return Promise.resolve(false);
  }
}
