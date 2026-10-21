import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DISCLAIMER, formatInZone, IST } from "@astro/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import enCore from "../messages/en.json" with { type: "json" };
import enAlmanac from "../messages/en/almanac.json" with { type: "json" };
import enBilling from "../messages/en/billing.json" with { type: "json" };
import enMarket from "../messages/en/marketplace.json" with { type: "json" };
import enReport from "../messages/en/report.json" with { type: "json" };
import enTools from "../messages/en/tools.json" with { type: "json" };
import hiReport from "../messages/hi/report.json" with { type: "json" };
import hiTools from "../messages/hi/tools.json" with { type: "json" };
// Generated from the astro engine by scripts/report-fixtures.mjs; never hand-typed.
import fxKundliEn from "./fixtures/report/fixture-kundli-en.json" with { type: "json" };
import fxKundliHi from "./fixtures/report/fixture-kundli-hi.json" with { type: "json" };
import fxMatchEn from "./fixtures/report/fixture-matching-en.json" with { type: "json" };
import fxMatchHi from "./fixtures/report/fixture-matching-hi.json" with { type: "json" };
import fxNoTime from "./fixtures/report/fixture-kundli-notime-en.json" with { type: "json" };

vi.mock("server-only", () => ({}));
vi.mock("next-intl/middleware", () => ({ default: () => () => undefined }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));

import PrintLayout, { metadata as printMetadata } from "../src/app/print/layout";
import PrintReportPage from "../src/app/print/reports/[id]/page";
import { GET as errorRoute } from "../src/app/print/error/[status]/route";
import robots from "../src/app/robots";
import { config as proxyConfig } from "../src/proxy";
import { ReportDocument } from "../src/components/report/ReportDocument";
import { asRenderData, type RenderData } from "../src/lib/report/types";

const data = (fx: unknown) => asRenderData(fx)!;
const kundliEn = data(fxKundliEn);
const kundliHi = data(fxKundliHi);
const matchEn = data(fxMatchEn);
const matchHi = data(fxMatchHi);
const noTime = data(fxNoTime);

const html = (d: RenderData) => renderToStaticMarkup(<ReportDocument data={d} />);
/** React escapes quotes in text; engine DMS strings carry ' and ". */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const istDate = (iso: string, lang: "en" | "hi") =>
  formatInZone(iso, IST, lang === "hi" ? "hi-IN" : "en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

const T = { en: enReport.printReport, hi: hiReport.printReport };
const TOOLS = { en: enTools.toolsUi, hi: hiTools.toolsUi };

describe("fixtures", () => {
  it("are valid RenderData generated from the engine", () => {
    for (const d of [kundliEn, kundliHi, matchEn, matchHi, noTime]) expect(d).not.toBeNull();
    expect(fxKundliEn._comment).toMatch(/report-fixtures\.mjs/);
    expect(kundliEn.snapshot.kundlis[0]!.kundli.settings.engine).toBe("swiss_ephemeris");
  });
});

const KUNDLI_SECTIONS = [
  "cover",
  "contents",
  "birth",
  "panchang",
  "periods",
  "chart-north",
  "chart-south",
  "planets",
  "houses",
  "nakshatras",
  "dasha",
  "doshas",
  "sade-sati",
  "numerology",
  "method",
  "disclaimer",
];

describe.each([
  ["en", kundliEn],
  ["hi", kundliHi],
] as const)("kundli report (%s)", (lang, d) => {
  const out = html(d);
  const e = d.snapshot.kundlis[0]!;
  const t = T[lang];

  it("has every section of revenue.md §2.4, each new section on its own page", () => {
    for (const id of KUNDLI_SECTIONS) expect(out).toContain(`data-section="${id}"`);
    expect(out.match(/class="r-section"/g)!.length).toBe(KUNDLI_SECTIONS.length - 1);
    expect(out).toContain(`lang="${lang}"`);
  });

  it("gives every section a How to read this note in the report language", () => {
    const notes = out.match(/data-howto=""/g)!.length;
    expect(notes).toBeGreaterThanOrEqual(13);
    expect(out).toContain(t.howToRead);
    if (lang === "hi") expect(out).not.toContain(enReport.printReport.howToRead);
  });

  it("shows the birth details and the panchang element running at birth", () => {
    expect(out).toContain(e.label);
    expect(out).toContain(e.birth.place.name);
    expect(out).toContain("06:30 (Asia/Kolkata)");
    const p = e.panchang;
    const birth = Date.parse(e.kundli.birth.utc);
    const tithi = p.tithis.find((s) => Date.parse(s.start) <= birth && birth < Date.parse(s.end))!;
    expect(out).toContain(lang === "hi" ? tithi.hi : tithi.en);
    expect(out).toContain(lang === "hi" ? p.vaara.hi : p.vaara.en);
    // Sunrise in the birth place's own zone, never the machine's.
    expect(out).toContain(
      formatInZone(p.sunrise, p.place.tz, "en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }),
    );
    expect(out).toContain(`data-choghadiya="day"`);
    expect(out).toMatch(/class="r-mark"/);
  });

  it("draws both chart styles with the site's chart components", () => {
    expect(out).toContain('data-chart="north"');
    expect(out).toContain('data-chart="south"');
    expect(out).toContain('data-lagna=""');
  });

  it("lists every graha with the engine's sign, degree, nakshatra and house", () => {
    for (const g of e.kundli.grahas) {
      const row = out.match(new RegExp(`<tr data-graha="${g.id}">(.*?)</tr>`))![1]!;
      expect(row).toContain(esc(g.dms_in_sign));
      expect(row).toContain(`>${g.pada}<`);
      expect(row).toContain(`>${g.house}<`);
    }
    expect(out).toContain(esc(e.kundli.ascendant!.dms_in_sign));
    // Mars is in Aries at 27°23′ (engine), shown in the report language.
    expect(out).toContain(lang === "hi" ? "मेष" : "Aries");
  });

  it("lists 12 houses with occupants and sign lords from data/astro", () => {
    const rows = out.match(/<tr data-house="\d+">/g)!;
    expect(rows.length).toBe(12);
    const h1 = out.match(/<tr data-house="1">(.*?)<\/tr>/)![1]!;
    // Leo rising (engine): lord Sun (signs.json) sits in house 12; Mercury occupies house 1.
    expect(e.kundli.houses![0]!.sign_index).toBe(4);
    expect(h1).toContain(lang === "hi" ? "सूर्य" : "Sun");
    expect(h1).toContain(lang === "hi" ? "बुध" : "Mercury");
    expect(h1).toContain(lang === "hi" ? "भाव 12" : "House 12");
  });

  it("names the nakshatras of the Moon, Sun and ascendant", () => {
    expect(out).toContain('data-nakshatra="rohini"');
    expect(out).toContain('data-nakshatra="ashlesha"');
    expect(out).toContain('data-nakshatra="magha"');
  });

  it("lists all mahadashas with IST dates and the antardashas of the current and next", () => {
    const d0 = e.dasha;
    expect(out.match(/data-mahadashas=""/)).not.toBeNull();
    for (const m of d0.mahadashas) expect(out).toContain(istDate(m.end, lang));
    expect(out).toContain('data-antardashas="current"');
    expect(out).toContain('data-antardashas="next"');
    expect(d0.current!.mahadasha).toBe("jupiter");
    const jupiter = d0.mahadashas.find((m) => m.lord === "jupiter")!;
    for (const a of jupiter.antardashas) expect(out).toContain(istDate(a.start, lang));
  });

  it("shows the dosha results with the tables' review status, like the site", () => {
    expect(e.doshas.tables_review_status).toBe("needs_astrologer_review");
    expect(out).toContain('data-dosha="mangal" data-present="true"');
    expect(out).toContain('data-dosha="kaal_sarp" data-present="false"');
    expect(out).toContain('data-review="needs_astrologer_review"');
    expect(out).toContain(TOOLS[lang].result.pendingReview);
    for (const cy of e.doshas.sade_sati.cycles) expect(out).toContain(istDate(cy.start, lang));
  });

  it("shows numerology from the engine", () => {
    const n = e.numerology!;
    expect(out).toContain(`<p class="r-big">${n.mulank!.number}</p>`);
    expect(out).toContain(n.bhagyank!.steps.replace(/>/g, "&gt;"));
    expect(out).toContain(`<p class="r-big">${n.name_number!.number}</p>`);
  });

  it("states the method and sources from the engine meta", () => {
    const s = e.kundli.settings;
    expect(out).toContain(`${s.ayanamsha_deg.toFixed(4)}°`);
    expect(out).toContain(d.snapshot.meta.ephemeris_version);
    expect(out).toContain(d.snapshot.meta.source);
    expect(out).toContain('data-table="matching" data-status="needs_astrologer_review"');
  });

  it("ends with the entertainment disclaimer", () => {
    expect(out).toContain(DISCLAIMER[lang]);
    expect(out.match(/data-disclaimer=""/g)!.length).toBe(2);
  });

  it("prints the creation date in IST on the cover", () => {
    expect(out).toContain("14:00 IST");
  });

  it("puts a page counter in the @page footer", () => {
    expect(out).toContain("counter(page)");
    expect(out).toContain("counter(pages)");
    expect(out).toContain(`"${t.pageFooter} "`);
  });
});

describe.each([
  ["en", matchEn],
  ["hi", matchHi],
] as const)("matching report (%s)", (lang, d) => {
  const out = html(d);
  const m = d.snapshot.match!;

  it("shows both people's charts and positions", () => {
    for (const id of ["charts-1", "charts-2", "planets-1", "planets-2", "panchang-1", "panchang-2"])
      expect(out).toContain(`data-section="${id}"`);
    expect(out.match(/data-chart="north"/g)!.length).toBe(2);
    expect(out.match(/data-chart="south"/g)!.length).toBe(2);
    for (const e of d.snapshot.kundlis) expect(out).toContain(e.label);
  });

  it("lists the 8 kootas with points, the total and the review status", () => {
    expect(m.kootas.length).toBe(8);
    for (const k of m.kootas) {
      const row = out.match(new RegExp(`<tr data-koota="${k.koota}">(.*?)</tr>`))![1]!;
      expect(row).toContain(`>${Number.isInteger(k.points) ? k.points : k.points.toFixed(1)}<`);
      expect(row).toContain(`>${k.max}<`);
    }
    const total = out.match(/<tr data-total="">(.*?)<\/tr>/)![1]!;
    expect(total).toContain(`>${m.total}<`);
    expect(total).toContain(">36<");
    expect(out).toContain(`data-review="${m.tables_review_status}"`);
    const tm = TOOLS[lang].match;
    if (m.doshas.nadi) expect(out).toContain(tm.nadiDosha);
    else expect(out).not.toContain(tm.nadiDosha);
    if (m.doshas.bhakoot) expect(out).toContain(tm.bhakootDosha);
    else expect(out).not.toContain(tm.bhakootDosha);
  });

  it("shows Mangal compatibility for both partners", () => {
    expect(out).toContain('data-mangal-summary=""');
    expect(m.groom.mangal_dosha.present && m.bride.mangal_dosha.present).toBe(true);
    expect(out).toContain(T[lang].matching.mangalBoth);
    expect(out.match(/data-dosha="mangal"/g)!.length).toBe(2);
  });
});

describe("unknown birth time", () => {
  const out = html(noTime);
  it("says so, and leaves out houses and the ascendant instead of inventing them", () => {
    expect(out).toContain(enReport.printReport.birth.unknownTime);
    expect(out).toContain(enReport.printReport.houses.noTime);
    expect(out).not.toContain('data-graha="ascendant"');
    expect(out).toContain('data-mode="moon"');
    expect(out).toContain(enReport.printReport.panchang.wholeDay);
  });
});

describe("time zones", () => {
  const original = process.env.TZ;
  afterEach(() => {
    process.env.TZ = original;
  });

  it("renders the same bytes whatever the machine's time zone", () => {
    process.env.TZ = "America/Los_Angeles";
    const a = html(kundliEn) + html(matchHi);
    process.env.TZ = "Pacific/Kiritimati";
    const b = html(kundliEn) + html(matchHi);
    process.env.TZ = "UTC";
    const c = html(kundliEn) + html(matchHi);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("report code never formats with the host zone", () => {
    const roots = ["src/lib/report", "src/components/report", "src/app/print"];
    const files = roots.flatMap((r) =>
      readdirSync(join(__dirname, "..", r), { recursive: true, encoding: "utf8" })
        .filter((f) => /\.tsx?$/.test(f))
        .map((f) => join(__dirname, "..", r, f)),
    );
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(
        /toLocale(Date|Time)?String|\.get(Hours|Minutes|Date|Day|Month|FullYear)\(|getTimezoneOffset/,
      );
      expect(src, f).not.toMatch(/new Intl\.DateTimeFormat/);
    }
  });
});

describe("messages", () => {
  const keys = (o: object, p = ""): string[] =>
    Object.entries(o).flatMap(([k, v]) =>
      typeof v === "object" && v !== null && !Array.isArray(v)
        ? keys(v, `${p}${k}.`)
        : [`${p}${k}`],
    );
  const leaves = (o: unknown): string[] =>
    typeof o === "string"
      ? [o]
      : Array.isArray(o)
        ? o.flatMap(leaves)
        : Object.values(o as object).flatMap(leaves);

  it("Hindi report copy has the same keys and is translated", () => {
    expect(keys(hiReport).sort()).toEqual(keys(enReport).sort());
    const en = leaves(enReport);
    const copied = leaves(hiReport).filter((s, i) => s === en[i] && /[a-z]{3}/i.test(s));
    expect(copied).toEqual([]);
  });

  it("uses its own top-level namespace", () => {
    const others = [enCore, enTools, enAlmanac, enMarket, enBilling].flatMap((m) => Object.keys(m));
    expect(others).not.toContain("printReport");
    expect(Object.keys(enReport)).toEqual(["printReport"]);
  });

  it("How to read this copy makes no predictions", () => {
    const text = leaves(enReport).join(" ").toLowerCase();
    for (const w of ["you will", "lucky", "unlucky", "guaranteed success", "auspicious for you"])
      expect(text).not.toContain(w);
  });
});

describe("print page", () => {
  const params = (id: string) => Promise.resolve({ id });
  const search = (sig?: string) => Promise.resolve(sig === undefined ? {} : { sig });
  const UUID = "0b9d2c4e-1f3a-4b5c-8d6e-7f8091a2b3c4";
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("is private: noindex, nofollow, disallowed in robots.txt and outside locale routing", () => {
    expect(printMetadata.robots).toMatchObject({ index: false, follow: false });
    const rules = robots().rules;
    const disallow = (Array.isArray(rules) ? rules : [rules]).flatMap((r) => r.disallow ?? []);
    expect(disallow).toContain("/print/");
    const matcher = new RegExp(`^${proxyConfig.matcher}$`);
    expect(matcher.test("/print/reports/abc")).toBe(false);
    expect(matcher.test("/kundli")).toBe(true);
  });

  it("renders without app chrome or client components", async () => {
    const page = await PrintReportPage({
      params: params("fixture-kundli-hi"),
      searchParams: search(),
    });
    const out = renderToStaticMarkup(<PrintLayout>{page}</PrintLayout>);
    expect(out).toContain('data-theme="light"');
    expect(out).not.toMatch(/<(header|nav|footer)\b/);
    expect(out).toContain('data-report="kundli_report"');
    for (const f of readdirSync(join(__dirname, "../src/components/report")))
      if (f.endsWith(".tsx"))
        expect(readFileSync(join(__dirname, "../src/components/report", f), "utf8")).not.toContain(
          '"use client"',
        );
  });

  it("fetches RenderData server-side with the signature and renders it", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ...fxKundliEn, report: { ...fxKundliEn.report, id: UUID } }),
    );
    const page = await PrintReportPage({ params: params(UUID), searchParams: search("s.ig-1") });
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(
      new RegExp(`/v1/reports/render/${UUID}\\?sig=s\\.ig-1$`),
    );
    expect(renderToStaticMarkup(page)).toContain("Asha Verma");
  });

  it.each([
    [403, "REDIRECT /print/error/403"],
    [401, "REDIRECT /print/error/403"],
    [410, "REDIRECT /print/error/410"],
    [500, "REDIRECT /print/error/502"],
    [404, "NOT_FOUND"],
  ])("upstream %i becomes %s", async (status, expected) => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: { code: "x" } }, status));
    await expect(
      PrintReportPage({ params: params(UUID), searchParams: search("abc") }),
    ).rejects.toThrow(expected);
  });

  it("rejects a missing signature, a bad id and a mismatched report without rendering", async () => {
    await expect(PrintReportPage({ params: params(UUID), searchParams: search() })).rejects.toThrow(
      "REDIRECT /print/error/403",
    );
    await expect(
      PrintReportPage({ params: params("../../etc"), searchParams: search("abc") }),
    ).rejects.toThrow("NOT_FOUND");
    fetchMock.mockResolvedValue(jsonResponse(fxKundliEn));
    await expect(
      PrintReportPage({ params: params(UUID), searchParams: search("abc") }),
    ).rejects.toThrow("REDIRECT /print/error/502");
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(
      PrintReportPage({ params: params(UUID), searchParams: search("abc") }),
    ).rejects.toThrow("REDIRECT /print/error/502");
  });

  it("serves the fixture preview only outside production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(
      PrintReportPage({ params: params("fixture-kundli-en"), searchParams: search() }),
    ).rejects.toThrow("NOT_FOUND");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("error pages answer with the real status, noindex and no caching", async () => {
    for (const s of ["403", "410", "502"]) {
      const res = await errorRoute(new Request("http://x"), {
        params: Promise.resolve({ status: s }),
      });
      expect(res.status).toBe(Number(s));
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await res.text();
      expect(body).toContain(enReport.printReport.errors[s as "403"]);
      expect(body).toContain(hiReport.printReport.errors[s as "403"]);
    }
    const odd = await errorRoute(new Request("http://x"), {
      params: Promise.resolve({ status: "200" }),
    });
    expect(odd.status).toBe(404);
  });
});
