/**
 * First-party analytics settings (docs/api/growth.md §1.1, ADR-0013). Pure data: safe to import
 * from server and client code. The legal text quotes the cookie and retention periods from here.
 */

/** Pseudonymous id: random, HttpOnly, set by POST /api/e. The browser never reads it. */
export const AID_COOKIE = "aid";
export const AID_COOKIE_DAYS = 180;
export const AID_MAX_AGE_S = AID_COOKIE_DAYS * 24 * 3600;

/** Opt-out flag set by the privacy page switch. Readable by page scripts (it holds no id). */
export const OPT_OUT_COOKIE = "aid_off";
export const OPT_OUT_MAX_AGE_S = 365 * 24 * 3600;

/** Raw events are purged after this many days by the API (ANALYTICS_RETENTION_DAYS). */
export const ANALYTICS_RETENTION_DAYS = 400;

export const COLLECT_URL = "/api/e";
export const OPT_OUT_URL = "/api/e/opt-out";
export const MAX_BATCH = 20;
export const FLUSH_INTERVAL_MS = 5000;
