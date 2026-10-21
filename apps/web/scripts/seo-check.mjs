// SEO crawler (PLAN.md §5 Phase 2 acceptance and §7): fetches the sitemap and every URL in it.
// Fails on: non-200, wrong <html lang>, missing/duplicate title or description, canonical not
// equal to the URL, missing hreflang, invalid JSON-LD or missing Organization/BreadcrumbList/FAQPage,
// < 800 characters of visible text in <main>, Hindi pages without Devanagari, and dated pages whose
// IST date differs between title, description and body (or is not today/tomorrow where it must be).
//
// Usage: BASE_URL=http://localhost:3000 node scripts/seo-check.mjs
const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const SITE = (process.env.SITE_URL ?? BASE).replace(/\/$/, ""); // host used inside the sitemap
const MIN_TEXT = 800;
const CONCURRENCY = 8;

const decode = (s) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}="([^"]*)"`, "i").exec(tag);
  return m ? decode(m[1]) : null;
};

function istDates(now = new Date()) {
  const fmt = (d) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  const today = fmt(now);
  const [y, m, d] = today.split("-").map(Number);
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return { today, tomorrow };
}

function mainText(html) {
  const m = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html);
  if (!m) return "";
  return decode(
    m[1]
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function checkPage(url, html, { today, tomorrow }) {
  const problems = [];
  const path = new URL(url).pathname;
  const locale = path === "/hi" || path.startsWith("/hi/") ? "hi" : "en";

  const lang = /<html[^>]*\blang="([^"]+)"/i.exec(html)?.[1];
  if (lang !== locale) problems.push(`html lang=${lang}, expected ${locale}`);

  const titles = [...html.matchAll(/<title>([\s\S]*?)<\/title>/gi)].map((m) => decode(m[1]).trim());
  if (titles.length !== 1 || !titles[0])
    problems.push(`expected one non-empty <title>, got ${titles.length}`);
  const descTags = [...html.matchAll(/<meta[^>]*name="description"[^>]*>/gi)].map(
    (m) => attr(m[0], "content") ?? "",
  );
  if (descTags.length !== 1 || !descTags[0])
    problems.push(`expected one meta description, got ${descTags.length}`);

  const canonical = [...html.matchAll(/<link[^>]*rel="canonical"[^>]*>/gi)].map((m) =>
    attr(m[0], "href"),
  );
  // "https://x" and "https://x/" are the same URL (Next.js drops the root slash).
  const same = (a, b) =>
    a === b ||
    (a && b && a.replace(/\/$/, "") === b.replace(/\/$/, "") && new URL(a).pathname.length <= 1);
  if (canonical.length !== 1 || !same(canonical[0], url))
    problems.push(`canonical ${canonical.join(",") || "missing"} != ${url}`);
  const hreflangs = new Set(
    [...html.matchAll(/<link[^>]*rel="alternate"[^>]*>/gi)].map(
      (m) => attr(m[0], "hrefLang") ?? attr(m[0], "hreflang"),
    ),
  );
  for (const l of ["en", "hi", "x-default"])
    if (!hreflangs.has(l)) problems.push(`missing hreflang ${l}`);

  const types = new Set();
  for (const m of html.matchAll(
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      const data = JSON.parse(m[1]);
      for (const d of Array.isArray(data) ? data : [data]) types.add(d["@type"]);
    } catch (e) {
      problems.push(`invalid JSON-LD: ${e.message}`);
    }
  }
  for (const t of ["Organization", "BreadcrumbList"])
    if (!types.has(t)) problems.push(`missing ${t} JSON-LD`);
  const hasFaq = /<details\b/i.test(/<main\b[\s\S]*<\/main>/i.exec(html)?.[0] ?? "");
  if (hasFaq && !types.has("FAQPage")) problems.push("FAQs shown but no FAQPage JSON-LD");

  const text = mainText(html);
  if (text.length < MIN_TEXT) problems.push(`main text ${text.length} chars < ${MIN_TEXT}`);
  if (locale === "hi" && !/[ऀ-ॿ]/.test(text))
    problems.push("Hindi page without Devanagari in <main>");

  // Dated pages: one IST date in title, description and body.
  const time = /<time[^>]*data-ist-date="([^"]+)"[^>]*>([\s\S]*?)<\/time>/i.exec(html);
  if (time) {
    const iso = time[1];
    const shown = decode(time[2].replace(/<[^>]+>/g, "")).trim();
    if (!titles[0]?.includes(shown)) problems.push(`title lacks the page date "${shown}"`);
    if (!descTags[0]?.includes(shown)) problems.push(`description lacks the page date "${shown}"`);
    const tail = path.replace(/^\/hi/, "");
    const expected = /^\/panchang\/[^/]+\/tomorrow$/.test(tail)
      ? tomorrow
      : /^\/panchang(\/[^/]+)?$/.test(tail) || /^\/horoscope\/daily\//.test(tail)
        ? today
        : null;
    if (expected && iso !== expected) problems.push(`page date ${iso}, expected IST ${expected}`);
  } else if (/^(\/hi)?\/(panchang(\/[^/]+(\/tomorrow)?)?|horoscope\/daily\/[^/]+)$/.test(path)) {
    problems.push("dated page without a data-ist-date <time>");
  }
  return { problems, description: descTags[0] ?? "", title: titles[0] ?? "" };
}

async function fetchText(url) {
  const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(60_000) });
  return { status: res.status, text: await res.text() };
}

const local = (u) => (SITE !== BASE && u.startsWith(SITE) ? BASE + u.slice(SITE.length) : u);

async function main() {
  const failures = [];
  const robots = await fetchText(`${BASE}/robots.txt`);
  if (robots.status !== 200 || !/Sitemap:/i.test(robots.text))
    failures.push(["/robots.txt", [`status ${robots.status} or no Sitemap line`]]);

  const sm = await fetchText(`${BASE}/sitemap.xml`);
  if (sm.status !== 200) throw new Error(`sitemap.xml status ${sm.status}`);
  const urls = [...new Set([...sm.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => decode(m[1])))];
  if (!urls.length) throw new Error("sitemap has no URLs");

  const dates = istDates();
  const descriptions = new Map();
  let done = 0;
  const queue = [...urls];
  async function worker() {
    for (let url = queue.shift(); url; url = queue.shift()) {
      try {
        const { status, text } = await fetchText(local(url));
        if (status !== 200) {
          failures.push([url, [`status ${status}`]]);
        } else {
          const r = checkPage(url, text, dates);
          if (r.problems.length) failures.push([url, r.problems]);
          const seen = descriptions.get(r.description);
          if (seen) failures.push([url, [`meta description duplicates ${seen}`]]);
          else descriptions.set(r.description, url);
        }
      } catch (e) {
        failures.push([url, [`fetch failed: ${e.message}`]]);
      }
      done++;
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(
    `seo-check: ${done} URLs from the sitemap, ${failures.length} with problems (IST today ${dates.today})`,
  );
  for (const [url, problems] of failures.sort()) {
    console.log(`FAIL ${url}`);
    for (const p of problems) console.log(`  - ${p}`);
  }
  if (failures.length) process.exit(1);
  console.log("PASS all pages");
}

main().catch((e) => {
  console.error(`seo-check error: ${e.message}`);
  process.exit(1);
});
