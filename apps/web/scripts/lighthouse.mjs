// Lighthouse mobile audit (PLAN.md §5 Phase 2 acceptance: Lighthouse >= 90 on mobile).
// Usage: BASE_URL=http://localhost:3000 CHROME_PATH=/path/to/chrome node scripts/lighthouse.mjs
// Pages that 404 (not built yet) are skipped with a warning; anything else below 90 fails.
// Each page is audited RUNS times (default 3) and scored by its median-performance run, as
// Lighthouse recommends: single runs on shared CI machines swing by 5-10 points.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const LIGHTHOUSE = "lighthouse@12.8.2";
const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const MIN = Number(process.env.LIGHTHOUSE_MIN ?? 90);
const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"];
const RUNS = Math.max(1, Number(process.env.LIGHTHOUSE_RUNS ?? 3));
const PAGES = (
  process.env.LIGHTHOUSE_PAGES ??
  "/,/hi,/kundli,/tools/nakshatra,/kundli-matching,/panchang/new-delhi,/horoscope/daily/aries,/hi/horoscope/daily/aries,/astrologers"
)
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);

// One astrologer profile, if any is public (first <loc> under /astrologers/<slug> in the sitemap).
if (!process.env.LIGHTHOUSE_PAGES) {
  try {
    const xml = await (await fetch(`${BASE}/sitemap.xml`)).text();
    const m = xml.match(/<loc>[^<]*?(\/astrologers\/(?!apply<)[a-z0-9-]+)<\/loc>/);
    if (m) PAGES.push(m[1]);
    else console.warn("SKIP astrologer profile (none public in the sitemap)");
  } catch {
    console.warn("SKIP astrologer profile (sitemap unavailable)");
  }
}

// A non-production build sends `X-Robots-Tag: noindex` and a disallow-all robots.txt on purpose
// (docs/api/growth.md §3), which Lighthouse's "is-crawlable" audit counts against SEO. Skip that
// one audit then, and only then; a production build is audited in full.
let noindexBuild = false;
try {
  noindexBuild = /noindex/i.test((await fetch(`${BASE}/`)).headers.get("x-robots-tag") ?? "");
} catch {
  /* the per-page probe below reports an unreachable server */
}
if (noindexBuild)
  console.warn(
    "NOTE non-production build (X-Robots-Tag: noindex): skipping the is-crawlable audit",
  );

const out = mkdtempSync(path.join(tmpdir(), "lh-"));
let failed = false;
const rows = [];
try {
  for (const page of PAGES) {
    const url = BASE + page;
    // Lighthouse runs synchronously and blocks the event loop, so a pooled keep-alive socket can
    // be closed by the server unnoticed; the first request afterwards may land on it. Retry once.
    const probe = async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch(url, { redirect: "manual" });
          await res.arrayBuffer();
          return res.status;
        } catch {
          /* stale socket; retry */
        }
      }
      return 0;
    };
    const status = await probe();
    if (status === 404) {
      console.warn(`SKIP ${page} (404, not built yet)`);
      continue;
    }
    if (status !== 200) {
      console.error(`FAIL ${page}: status ${status}`);
      failed = true;
      continue;
    }
    await probe(); // warm the server so run 1 is not a cold start
    const reports = [];
    for (let run = 1; run <= RUNS; run++) {
      const file = path.join(out, `${page.replace(/\W+/g, "_") || "home"}-${run}.json`);
      execFileSync(
        "npx",
        [
          "--yes",
          LIGHTHOUSE,
          url,
          "--quiet",
          "--output=json",
          `--output-path=${file}`,
          `--only-categories=${CATEGORIES.join(",")}`,
          "--form-factor=mobile",
          ...(noindexBuild ? ["--skip-audits=is-crawlable"] : []),
          "--chrome-flags=--headless=new --no-sandbox --disable-gpu",
        ],
        { stdio: ["ignore", "ignore", "inherit"], env: process.env },
      );
      reports.push(JSON.parse(readFileSync(file, "utf8")));
    }
    reports.sort(
      (a, b) => (a.categories.performance?.score ?? 0) - (b.categories.performance?.score ?? 0),
    );
    const report = reports[Math.floor(reports.length / 2)];
    const scores = Object.fromEntries(
      CATEGORIES.map((c) => [c, Math.round((report.categories[c]?.score ?? 0) * 100)]),
    );
    const low = Object.entries(scores).filter(([, s]) => s < MIN);
    rows.push({ page, ...scores });
    if (low.length) {
      failed = true;
      const audits = Object.values(report.audits)
        .filter((a) => a.score !== null && a.score < 0.9 && a.scoreDisplayMode !== "informative")
        .map((a) => `${a.id} (${a.displayValue ?? a.score})`)
        .slice(0, 8);
      console.error(
        `FAIL ${page}: ${low.map(([c, s]) => `${c} ${s}`).join(", ")}; check: ${audits.join("; ")}`,
      );
      // Name the elements behind layout shift and LCP, so CI failures are diagnosable.
      for (const id of ["layout-shifts", "largest-contentful-paint-element"]) {
        for (const item of report.audits[id]?.details?.items ?? []) {
          const rows = item.type === "table" ? item.items : [item];
          for (const r of rows) {
            if (!r.node) continue;
            const causes = (r.subItems?.items ?? []).map((c) => c.cause ?? JSON.stringify(c));
            console.error(
              `  ${id}: ${r.score ?? ""} ${r.node.selector} ${r.node.snippet?.slice(0, 120)}` +
                (causes.length ? ` causes: ${causes.join(", ")}` : ""),
            );
          }
        }
      }
    }
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
console.table(rows);
process.exit(failed ? 1 : 0);
