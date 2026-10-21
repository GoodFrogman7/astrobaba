import { afterEach, describe, expect, it, vi } from "vitest";
import robots from "../src/app/robots";
import { GET as indexNowKeyRoute } from "../src/app/api/indexnow-key/[key]/route";
import { indexNowKey, isProductionSite, siteVerification } from "../src/lib/publishing";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("robots.txt", () => {
  it("disallows everything outside production", () => {
    for (const env of ["", "staging", "preview", "Production"]) {
      vi.stubEnv("NEXT_PUBLIC_SITE_ENV", env);
      const r = robots();
      expect(r.rules).toEqual([{ userAgent: "*", disallow: "/" }]);
      expect(r.sitemap).toMatch(/\/sitemap\.xml$/);
    }
  });

  it("is unchanged in production", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ENV", "production");
    expect(isProductionSite()).toBe(true);
    expect(robots().rules).toEqual([
      { userAgent: "*", allow: "/", disallow: ["/api/", "/dev/", "/hi/dev/", "/print/"] },
    ]);
  });
});

describe("next.config headers and rewrites", () => {
  async function config() {
    const mod = (await import("../next.config")) as {
      default: {
        headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]>;
        rewrites: () => Promise<{ source: string; destination: string }[]>;
      };
    };
    return mod.default;
  }

  it("sends X-Robots-Tag: noindex on every response outside production", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ENV", "staging");
    const [all] = await (await config()).headers();
    expect(all!.source).toBe("/:path*");
    expect(all!.headers).toContainEqual({ key: "X-Robots-Tag", value: "noindex" });
  });

  it("does not in production", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ENV", "production");
    const [all] = await (await config()).headers();
    expect(all!.headers.map((h) => h.key)).not.toContain("X-Robots-Tag");
  });

  it("rewrites /{key}.txt to the IndexNow key handler", async () => {
    expect(await (await config()).rewrites()).toContainEqual({
      source: "/:key([A-Za-z0-9-]{8,128}).txt",
      destination: "/api/indexnow-key/:key",
    });
  });
});

describe("search engine verification", () => {
  it("adds only the tags that are configured", () => {
    expect(siteVerification({})).toBeUndefined();
    expect(siteVerification({ GOOGLE_SITE_VERIFICATION: "abc_DEF-123" })).toEqual({
      google: "abc_DEF-123",
    });
    expect(siteVerification({ BING_SITE_VERIFICATION: "0123ABCD" })).toEqual({
      other: { "msvalidate.01": "0123ABCD" },
    });
    expect(
      siteVerification({ GOOGLE_SITE_VERIFICATION: '"><script>', BING_SITE_VERIFICATION: " " }),
    ).toBeUndefined();
  });
});

describe("IndexNow key file", () => {
  const get = (key: string) =>
    indexNowKeyRoute(new Request(`http://localhost:3000/${key}.txt`), {
      params: Promise.resolve({ key }),
    });

  it("serves the key only when INDEXNOW_KEY is set, valid and requested", async () => {
    vi.stubEnv("INDEXNOW_KEY", "0123456789abcdef0123456789abcdef");
    const ok = await get("0123456789abcdef0123456789abcdef");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await ok.text()).toBe("0123456789abcdef0123456789abcdef");
    expect((await get("ffffffffffffffffffffffffffffffff")).status).toBe(404);
  });

  it("is 404 when the key is unset or malformed", async () => {
    vi.stubEnv("INDEXNOW_KEY", "");
    expect((await get("0123456789abcdef")).status).toBe(404);
    vi.stubEnv("INDEXNOW_KEY", "short");
    expect(indexNowKey()).toBeNull();
    expect((await get("short")).status).toBe(404);
    vi.stubEnv("INDEXNOW_KEY", "has_underscore_12345");
    expect((await get("has_underscore_12345")).status).toBe(404);
  });
});

/** scripts/indexnow.mjs, loaded as plain JS. */
interface Entry {
  loc: string;
  lastmod: string | null;
}
interface IndexNowModule {
  MAX_BATCH: number;
  parseSitemap: (xml: string) => Entry[];
  istDate: (now?: Date) => string;
  lastmodDate: (lastmod: string | null) => string | null;
  changedSince: (entries: Entry[], since: string) => string[];
  dailyHubUrls: (entries: Entry[]) => string[];
  batches: <T>(items: T[], size?: number) => T[][];
  urlsToSubmit: (entries: Entry[], since: string, siteUrl: string) => string[];
  parseArgs: (argv: string[]) => { since: string | null; dryRun: boolean };
  payload: (
    siteUrl: string,
    key: string,
    urlList: string[],
  ) => { host: string; key: string; keyLocation: string; urlList: string[] };
}
const SCRIPT = new URL("../scripts/indexnow.mjs", import.meta.url).href;
const load = async () => (await import(/* @vite-ignore */ SCRIPT)) as IndexNowModule;

const SITE = "https://astro.example";
const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
<url>
<loc>${SITE}/</loc>
<xhtml:link rel="alternate" hreflang="hi" href="${SITE}/hi" />
<changefreq>daily</changefreq>
</url>
<url><loc>${SITE}/panchang</loc></url>
<url><loc>${SITE}/hi/panchang</loc></url>
<url><loc>${SITE}/panchang/new-delhi</loc></url>
<url><loc>${SITE}/horoscope/daily/aries</loc></url>
<url><loc>${SITE}/hi/horoscope/daily/pisces</loc></url>
<url><loc>${SITE}/horoscope/weekly/aries</loc></url>
<url><loc>${SITE}/astrologers/a-b?x=1&amp;y=2</loc><lastmod>2026-10-21T03:00:00.000Z</lastmod></url>
<url><loc>${SITE}/astrologers/old</loc><lastmod>2026-10-01T10:00:00Z</lastmod></url>
<url><loc>${SITE}/learn/new-article</loc><lastmod>2026-10-21</lastmod></url>
<url><loc>${SITE}/learn/late-night</loc><lastmod>2026-10-20T20:00:00Z</lastmod></url>
<url><loc>https://elsewhere.example/x</loc><lastmod>2026-10-21</lastmod></url>
</urlset>`;

describe("indexnow script", () => {
  it("parses <loc> and <lastmod>, decoding entities", async () => {
    const m = await load();
    const entries = m.parseSitemap(SITEMAP);
    expect(entries).toHaveLength(12);
    expect(entries[0]).toEqual({ loc: `${SITE}/`, lastmod: null });
    expect(entries[7]).toEqual({
      loc: `${SITE}/astrologers/a-b?x=1&y=2`,
      lastmod: "2026-10-21T03:00:00.000Z",
    });
  });

  it("reads lastmod as an IST calendar date", async () => {
    const m = await load();
    expect(m.istDate(new Date("2026-10-20T19:00:00Z"))).toBe("2026-10-21"); // 00:30 IST
    expect(m.lastmodDate("2026-10-20T20:00:00Z")).toBe("2026-10-21");
    expect(m.lastmodDate("2026-10-21")).toBe("2026-10-21");
    expect(m.lastmodDate("garbage")).toBeNull();
    expect(m.lastmodDate(null)).toBeNull();
  });

  it("keeps URLs changed on or after --since, plus the daily hubs, on this host only", async () => {
    const m = await load();
    const entries = m.parseSitemap(SITEMAP);
    expect(m.changedSince(entries, "2026-10-21")).toEqual([
      `${SITE}/astrologers/a-b?x=1&y=2`,
      `${SITE}/learn/new-article`,
      `${SITE}/learn/late-night`,
      "https://elsewhere.example/x",
    ]);
    expect(m.dailyHubUrls(entries)).toEqual([
      `${SITE}/panchang`,
      `${SITE}/hi/panchang`,
      `${SITE}/horoscope/daily/aries`,
      `${SITE}/hi/horoscope/daily/pisces`,
    ]);
    const urls = m.urlsToSubmit(entries, "2026-10-21", SITE);
    expect(urls).toHaveLength(7);
    expect(urls).not.toContain("https://elsewhere.example/x");
    expect(m.urlsToSubmit(entries, "2026-10-01", SITE)).toContain(`${SITE}/astrologers/old`);
  });

  it("batches at most 10,000 URLs per request", async () => {
    const m = await load();
    expect(m.MAX_BATCH).toBe(10_000);
    const urls = Array.from({ length: 25_001 }, (_, i) => `${SITE}/p${i}`);
    expect(m.batches(urls).map((b) => b.length)).toEqual([10_000, 10_000, 5_001]);
    expect(m.batches([])).toEqual([]);
  });

  it("builds the IndexNow body with the key location", async () => {
    const m = await load();
    expect(m.payload(SITE, "0123456789abcdef", [`${SITE}/`])).toEqual({
      host: "astro.example",
      key: "0123456789abcdef",
      keyLocation: `${SITE}/0123456789abcdef.txt`,
      urlList: [`${SITE}/`],
    });
  });

  it("parses --since and --dry-run", async () => {
    const m = await load();
    expect(m.parseArgs([])).toEqual({ since: null, dryRun: false });
    expect(m.parseArgs(["--since", "2026-10-01", "--dry-run"])).toEqual({
      since: "2026-10-01",
      dryRun: true,
    });
    expect(m.parseArgs(["--since=2026-10-02"]).since).toBe("2026-10-02");
    expect(() => m.parseArgs(["--since", "yesterday"])).toThrow(/YYYY-MM-DD/);
    expect(() => m.parseArgs(["--force"])).toThrow(/unknown/);
  });
});
