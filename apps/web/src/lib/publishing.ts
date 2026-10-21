import type { Metadata } from "next";

/**
 * Publishing switches (docs/api/growth.md §3). Read from the environment at build time
 * (NEXT_PUBLIC_* values are inlined into the build), so set them when building the image.
 */
type Env = Record<string, string | undefined>;

/** Only the production site may be indexed; staging, previews and local builds say noindex. */
export function isProductionSite(env: Env = process.env): boolean {
  return env.NEXT_PUBLIC_SITE_ENV === "production";
}

const TOKEN = /^[A-Za-z0-9_-]{1,200}$/;

/** Search Console / Bing Webmaster verification <meta> tags, only for the values that are set. */
export function siteVerification(env: Env = process.env): Metadata["verification"] | undefined {
  const google = env.GOOGLE_SITE_VERIFICATION?.trim();
  const bing = env.BING_SITE_VERIFICATION?.trim();
  const v: NonNullable<Metadata["verification"]> = {};
  if (google && TOKEN.test(google)) v.google = google;
  if (bing && TOKEN.test(bing)) v.other = { "msvalidate.01": bing };
  return Object.keys(v).length ? v : undefined;
}

/** IndexNow key: 8-128 characters of [A-Za-z0-9-]; anything else counts as not configured. */
export const INDEXNOW_KEY_RE = /^[A-Za-z0-9-]{8,128}$/;

export function indexNowKey(env: Env = process.env): string | null {
  const key = env.INDEXNOW_KEY?.trim();
  return key && INDEXNOW_KEY_RE.test(key) ? key : null;
}
