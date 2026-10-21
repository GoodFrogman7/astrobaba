// SSR smoke test: boots the production build and checks that "/" and "/hi" are fully
// server-rendered in the right language. Usage: pnpm build && pnpm smoke
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = process.env.SMOKE_PORT ?? "3100";
const base = `http://127.0.0.1:${PORT}`;
const SITE = (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const server = spawn("node_modules/.bin/next", ["start", "--port", PORT], {
  stdio: ["ignore", "inherit", "inherit"],
  // Canonical URLs are baked in at build time, so check against the URL the build used.
  env: { ...process.env, NEXT_PUBLIC_SITE_URL: SITE },
});

const checks = [
  {
    path: "/",
    lang: "en",
    must: [
      "Clear answers from your birth chart",
      "Today in India",
      "For guidance and entertainment. Not medical, legal or financial advice.",
    ],
  },
  {
    path: "/hi",
    lang: "hi",
    must: ["आपकी जन्म कुंडली से साफ़ जवाब", "आज भारत में", "केवल मार्गदर्शन और मनोरंजन के लिए"],
  },
];

let failed = 0;
try {
  for (let i = 0; ; i++) {
    try {
      await fetch(base);
      break;
    } catch {
      if (i > 60) throw new Error("server did not start");
      await sleep(500);
    }
  }
  for (const c of checks) {
    const res = await fetch(base + c.path, { redirect: "manual" });
    const html = await res.text();
    const problems = [];
    if (res.status !== 200) problems.push(`status ${res.status}`);
    if (!html.includes(`<html lang="${c.lang}"`)) problems.push(`missing <html lang="${c.lang}">`);
    for (const s of c.must) if (!html.includes(s)) problems.push(`missing text: ${s}`);
    const canonical = c.lang === "en" ? SITE : `${SITE}/hi`;
    if (!html.includes(`<link rel="canonical" href="${canonical}"`))
      problems.push(`canonical not ${canonical}`);
    for (const l of ["en", "hi", "x-default"])
      if (!html.includes(`hrefLang="${l}"`)) problems.push(`missing hreflang ${l}`);
    console.log(
      `${problems.length ? "FAIL" : "PASS"} ${c.path} (${res.status}, ${html.length} bytes)`,
    );
    for (const p of problems) console.log(`  - ${p}`);
    failed += problems.length ? 1 : 0;
  }
  const nf = await fetch(base + "/xx-not-a-page");
  console.log(`${nf.status === 404 ? "PASS" : "FAIL"} unknown path returns 404 (${nf.status})`);
  if (nf.status !== 404) failed++;
} finally {
  server.kill();
}
process.exit(failed ? 1 : 0);
