import { isLocale, type EventName, type Locale } from "@astro/shared";
import { COLLECT_URL, FLUSH_INTERVAL_MS, OPT_OUT_COOKIE } from "./config";
import { beaconTransport, EventQueue } from "./queue";

/**
 * Browser side of the first-party analytics (docs/api/growth.md §1.1). Import only from client
 * components. Events carry closed-schema properties only: never names, birth details, phones,
 * emails or free text. Nothing is sent when the browser asks not to be tracked (GPC/DNT) or the
 * visitor turned analytics off on the privacy page; /api/e enforces the same rules.
 */
let queue: EventQueue | null = null;

/** GPC, DNT or the privacy page switch (cookie aid_off=1). */
export function analyticsDisabled(): boolean {
  if (typeof window === "undefined") return true;
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  if (nav.globalPrivacyControl === true || nav.doNotTrack === "1") return true;
  try {
    return document.cookie.split(";").some((c) => c.trim() === `${OPT_OUT_COOKIE}=1`);
  } catch {
    return false;
  }
}

function currentLocale(): Locale {
  const lang = document.documentElement.lang;
  return isLocale(lang) ? lang : "en";
}

function ensureQueue(): EventQueue {
  if (queue) return queue;
  const q = new EventQueue(beaconTransport(COLLECT_URL));
  window.setInterval(() => q.flush(), FLUSH_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") q.flush();
  });
  window.addEventListener("pagehide", () => q.flush());
  queue = q;
  return q;
}

/** Queue one event; returns false when it was not queued (disabled, or rejected by the schema). */
export function track(
  event: EventName,
  properties: Record<string, string | number | boolean> = {},
): boolean {
  if (analyticsDisabled()) return false;
  try {
    return ensureQueue().push({
      event,
      ts: new Date().toISOString(),
      locale: currentLocale(),
      properties,
    });
  } catch {
    return false;
  }
}

/** Drop anything not yet sent (used when the visitor turns analytics off). */
export function discardQueued(): void {
  queue?.clear();
}

const FIRST_VIEW_KEY = "ab_seen";
let seenInMemory = false;

/** True once per browser tab session (sessionStorage), for source/utm on the first page view. */
export function takeFirstPageView(): boolean {
  try {
    if (window.sessionStorage.getItem(FIRST_VIEW_KEY)) return false;
    window.sessionStorage.setItem(FIRST_VIEW_KEY, "1");
    return true;
  } catch {
    if (seenInMemory) return false;
    seenInMemory = true;
    return true;
  }
}
