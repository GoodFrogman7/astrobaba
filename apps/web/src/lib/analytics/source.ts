import type { TrafficSource } from "@astro/shared";

/**
 * Where a tab session came from (docs/api/growth.md §1.1). Pure and deterministic: no lookups,
 * no fingerprinting. A pattern ending in "." matches that label anywhere in the host
 * ("google." matches www.google.co.in); any other pattern is a domain matched with its
 * subdomains ("t.co", "x.com").
 */
export const SEARCH_HOSTS = ["google.", "bing.", "duckduckgo.", "yahoo.", "yandex.", "ecosia."];
export const SOCIAL_HOSTS = [
  "facebook.",
  "instagram.",
  "t.co",
  "x.com",
  "twitter.",
  "whatsapp.",
  "linkedin.",
  "youtube.",
  "reddit.",
  "pinterest.",
  "telegram.",
];

export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (pattern.endsWith(".")) return `.${h}`.includes(`.${pattern}`);
  return h === pattern || h.endsWith(`.${pattern}`);
}

function referrerHost(referrer: string | null | undefined): string | null {
  if (!referrer) return null;
  try {
    const u = new URL(referrer);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * `campaign` when a utm_source is present; `search`/`social` from the fixed host lists;
 * `referral` for any other host; `direct` when there is no referrer or it is this site.
 */
export function classifySource(
  referrer: string | null | undefined,
  ownHost: string | null | undefined,
  utmSource?: string | null,
): TrafficSource {
  if (utmSource) return "campaign";
  const host = referrerHost(referrer);
  if (!host) return "direct";
  if (ownHost && host === ownHost.toLowerCase()) return "direct";
  if (SEARCH_HOSTS.some((p) => hostMatches(host, p))) return "search";
  if (SOCIAL_HOSTS.some((p) => hostMatches(host, p))) return "social";
  return "referral";
}

/** utm value: lower-cased, characters outside [a-z0-9-] become "-", at most 80 characters. */
export function normalizeUtm(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const v = value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 80);
  return v ? v : undefined;
}
