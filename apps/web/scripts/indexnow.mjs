// IndexNow submission (docs/api/growth.md §3, docs/LAUNCH.md §4): tells Bing, Yandex and the
// other IndexNow engines which pages changed. Reads the live sitemap, keeps URLs whose <lastmod>
// is on or after --since (default: today in IST), adds the daily horoscope and panchang hub URLs
// (they change every day but carry no lastmod), and POSTs them in batches of up to 10,000.
// Google is not an IndexNow engine: submit the sitemap in Search Console instead.
//
// Usage: NEXT_PUBLIC_SITE_URL=https://example.in INDEXNOW_KEY=... \
//          node scripts/indexnow.mjs [--since YYYY-MM-DD] [--dry-run]
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export const ENDPOINT = "https://api.indexnow.org/indexnow";
export const MAX_BATCH = 10_000;
export const KEY_RE = /^[A-Za-z0-9-]{8,128}$/;

const decode = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, "&");

/** [{loc, lastmod}] from a sitemap's <url> entries (lastmod null when absent). */
export function parseSitemap(xml) {
  const out = [];
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = /<loc>\s*([^<]+?)\s*<\/loc>/.exec(m[1])?.[1];
    if (!loc) continue;
    const lastmod = /<lastmod>\s*([^<]+?)\s*<\/lastmod>/.exec(m[1])?.[1] ?? null;
    out.push({ loc: decode(loc), lastmod });
  }
  return out;
}

/** The calendar date in IST (YYYY-MM-DD) of an instant. */
export function istDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * The IST calendar date of a sitemap lastmod: a plain date stays as is; an instant is converted
 * to IST. null when it cannot be read.
 */
export function lastmodDate(lastmod) {
  if (!lastmod) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(lastmod)) return lastmod;
  const t = Date.parse(lastmod);
  return Number.isNaN(t) ? null : istDate(new Date(t));
}

/** URLs whose lastmod is on or after `since` (YYYY-MM-DD, IST). */
export function changedSince(entries, since) {
  return entries
    .filter((e) => {
      const d = lastmodDate(e.lastmod);
      return d !== null && d >= since;
    })
    .map((e) => e.loc);
}

/** Daily horoscope pages and the panchang hub, in every locale (from the sitemap itself). */
export function dailyHubUrls(entries) {
  return entries
    .map((e) => e.loc)
    .filter((loc) => {
      let path;
      try {
        path = new URL(loc).pathname.replace(/^\/hi(?=\/|$)/, "") || "/";
      } catch {
        return false;
      }
      return /^\/horoscope\/daily\/[a-z-]+$/.test(path) || path === "/panchang";
    });
}

/** Split into chunks of at most `size`. */
export function batches(items, size = MAX_BATCH) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The URLs to submit: changed since `since`, plus the daily hubs, deduplicated, same host only. */
export function urlsToSubmit(entries, since, siteUrl) {
  const host = new URL(siteUrl).host;
  const all = [...changedSince(entries, since), ...dailyHubUrls(entries)];
  return [...new Set(all)].filter((u) => {
    try {
      return new URL(u).host === host;
    } catch {
      return false;
    }
  });
}

export function parseArgs(argv) {
  const args = { since: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--since") args.since = argv[++i] ?? "";
    else if (a.startsWith("--since=")) args.since = a.slice("--since=".length);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (args.since !== null && !/^\d{4}-\d{2}-\d{2}$/.test(args.since))
    throw new Error("--since must be a date: YYYY-MM-DD");
  return args;
}

/** The IndexNow request body for one batch. */
export function payload(siteUrl, key, urlList) {
  const u = new URL(siteUrl);
  return { host: u.host, key, keyLocation: `${u.origin}/${key}.txt`, urlList };
}

async function main(argv, env = process.env) {
  const args = parseArgs(argv);
  const site = (env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/$/, "");
  if (!/^https?:\/\//.test(site)) throw new Error("set NEXT_PUBLIC_SITE_URL to the site origin");
  const key = env.INDEXNOW_KEY?.trim() ?? "";
  if (!args.dryRun && !KEY_RE.test(key))
    throw new Error("set INDEXNOW_KEY (8-128 characters of A-Z, a-z, 0-9 and -)");
  const since = args.since ?? istDate();

  const res = await fetch(`${site}/sitemap.xml`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`sitemap.xml: status ${res.status}`);
  const entries = parseSitemap(await res.text());
  const urls = urlsToSubmit(entries, since, site);
  console.log(
    `indexnow: ${entries.length} sitemap URLs, ${urls.length} to submit (since ${since})`,
  );
  if (args.dryRun) {
    for (const u of urls) console.log(`  ${u}`);
    console.log("indexnow: dry run, nothing submitted");
    return;
  }
  for (const [i, list] of batches(urls).entries()) {
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload(site, key, list)),
      signal: AbortSignal.timeout(60_000),
    });
    // 200 = accepted, 202 = accepted while the key is being verified.
    if (r.status !== 200 && r.status !== 202)
      throw new Error(`batch ${i + 1}: IndexNow answered ${r.status}`);
    console.log(`indexnow: batch ${i + 1} (${list.length} URLs) accepted (${r.status})`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch((e) => {
    console.error(`indexnow error: ${e.message}`);
    process.exit(1);
  });
