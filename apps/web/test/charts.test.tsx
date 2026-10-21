import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CHART_LABELS, NorthIndianChart, SouthIndianChart } from "@/components/charts";
import { SAMPLE_KNOWN_TIME, SAMPLE_UNKNOWN_TIME } from "@/components/charts/sample";
import type { ChartLocale, KundliChartData } from "@/components/charts";

const CHARTS = { north: NorthIndianChart, south: SouthIndianChart };
const LOCALES: ChartLocale[] = ["en", "hi"];

function render(kind: keyof typeof CHARTS, data: KundliChartData, locale: ChartLocale): string {
  const Chart = CHARTS[kind];
  return renderToStaticMarkup(<Chart data={data} locale={locale} />);
}

/** Text drawn inside the SVG only (excludes the accessible summary and sr-only list). */
function drawnText(html: string): string {
  const svg = html.slice(html.indexOf("<svg"), html.indexOf("</svg>"));
  return [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).join("\n");
}

describe.each(Object.keys(CHARTS) as (keyof typeof CHARTS)[])("%s Indian chart", (kind) => {
  it.each(LOCALES)("draws every graha exactly once (%s)", (locale) => {
    const text = drawnText(render(kind, SAMPLE_KNOWN_TIME, locale));
    for (const id of Object.keys(
      CHART_LABELS[locale].grahaShort,
    ) as (keyof typeof CHART_LABELS.en.grahaShort)[]) {
      const abbr = CHART_LABELS[locale].grahaShort[id];
      const hits = text.split(/\s+/).filter((token) => token === abbr).length;
      expect(hits, `${id} (${abbr})`).toBe(1);
    }
  });

  it("marks the lagna when the birth time is known", () => {
    const html = render(kind, SAMPLE_KNOWN_TIME, "en");
    expect(html).toContain("data-lagna");
    expect(html).not.toContain("data-unknown-time");
    expect(html).toContain('data-mode="lagna"');
  });

  it.each(LOCALES)(
    "falls back to a Moon chart and says so when the time is unknown (%s)",
    (locale) => {
      const html = render(kind, SAMPLE_UNKNOWN_TIME, locale);
      expect(html).not.toContain("data-lagna");
      expect(html).toContain("data-unknown-time");
      expect(html).toContain(CHART_LABELS[locale].unknownTime);
      expect(html).toContain('data-mode="moon"');
    },
  );

  it("is accessible: role=img, title, aria-label summary and a screen-reader list", () => {
    const html = render(kind, SAMPLE_KNOWN_TIME, "en");
    expect(html).toContain('role="img"');
    expect(html).toMatch(/<title>[^<]+<\/title>/);
    expect(html).toMatch(/aria-label="[^"]*Ascendant: Pisces/);
    expect(html).toContain('class="sr-only"');
    expect((html.match(/<li>/g) ?? []).length).toBe(12);
  });

  it("uses only design-token colours", () => {
    for (const data of [SAMPLE_KNOWN_TIME, SAMPLE_UNKNOWN_TIME])
      for (const locale of LOCALES) {
        const html = render(kind, data, locale);
        expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(html).not.toMatch(/rgb\(|hsl\(/);
      }
  });
});

describe("house placement", () => {
  it("north chart: house 1 carries the ascendant's sign number, houses run on from it", () => {
    const html = render("north", SAMPLE_KNOWN_TIME, "en");
    const asc = SAMPLE_KNOWN_TIME.ascendant!.sign_index;
    for (let h = 1; h <= 12; h++)
      expect(html).toContain(`data-house="${h}" data-sign="${(asc + h - 1) % 12}"`);
  });

  it("south chart: grahas sit in their own sign cell", () => {
    const html = render("south", SAMPLE_KNOWN_TIME, "en");
    // Split the markup at each cell marker; segment N holds the cell for sign N.
    const cells = new Map<number, string>();
    for (const part of html.split('data-sign="').slice(1)) {
      cells.set(Number(part.slice(0, part.indexOf('"'))), part);
    }
    for (const g of SAMPLE_KNOWN_TIME.grahas) {
      expect(cells.get(g.sign_index), g.id).toContain(`${CHART_LABELS.en.grahaShort[g.id]} `);
    }
  });

  it("moon chart starts from the Moon's sign", () => {
    const html = render("north", SAMPLE_UNKNOWN_TIME, "en");
    const moon = SAMPLE_UNKNOWN_TIME.grahas.find((g) => g.id === "moon")!.sign_index;
    expect(html).toContain(`data-house="1" data-sign="${moon}"`);
  });
});

describe("Hindi punctuation", () => {
  it("ends Hindi sentences with the danda, not a full stop", () => {
    const html = render("north", SAMPLE_UNKNOWN_TIME, "hi");
    expect(html).toContain(`${CHART_LABELS.hi.unknownTime}।`);
    expect(html).not.toContain(`${CHART_LABELS.hi.unknownTime}.`);
  });
});
