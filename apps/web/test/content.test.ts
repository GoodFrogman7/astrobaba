import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Editorial rules for src/content (PLAN.md §5 Phase 2 and §5 Phase 7 policy). */
const dir = (l: string) => new URL(`../src/content/${l}/`, import.meta.url);
const files = (l: string) => readdirSync(dir(l)).filter((f) => f.endsWith(".json")).sort();

interface PageContent {
  title: string;
  description: string;
  h1: string;
  intro: string;
  sections: { heading: string; body: string[] }[];
  faqs: { q: string; a: string }[];
}

const load = (l: string, f: string) =>
  JSON.parse(readFileSync(new URL(f, dir(l)), "utf8")) as PageContent;

const text = (c: PageContent) =>
  [c.intro, ...c.sections.flatMap((s) => [s.heading, ...s.body]), ...c.faqs.flatMap((f) => [f.q, f.a])].join(" ");

// Claims the product never makes: guaranteed outcomes, cures, fear-selling, financial calls.
const BANNED = [
  /guarantee/i, /\bcure/i, /100\s?%/, /definitely will/i, /\bdeath\b/i, /\bdoom/i, /curse/i,
  /gemstone/i, /invest(ment)? advice/i, /गारंटी/, /निश्चित रूप से/, /इलाज/, /श्राप/, /रत्न/,
];

describe("page content", () => {
  it("every page exists in English and Hindi", () => {
    expect(files("hi")).toEqual(files("en"));
  });

  for (const locale of ["en", "hi"]) {
    for (const f of files(locale)) {
      it(`${locale}/${f} follows the content rules`, () => {
        const c = load(locale, f);
        expect(c.title.length, "title").toBeGreaterThan(5);
        expect(c.title.length, "title").toBeLessThanOrEqual(70);
        expect(c.description.length, "description").toBeGreaterThanOrEqual(50);
        expect(c.description.length, "description").toBeLessThanOrEqual(160);
        expect(c.faqs.length, "4-6 FAQs").toBeGreaterThanOrEqual(4);
        expect(c.faqs.length, "4-6 FAQs").toBeLessThanOrEqual(6);
        expect(c.sections.length, "sections").toBeGreaterThan(0);
        expect(text(c).length, "body copy >= 800 characters").toBeGreaterThanOrEqual(800);
        for (const re of BANNED) expect(text(c) + c.title + c.description, String(re)).not.toMatch(re);
        if (locale === "hi") expect(c.intro, "Hindi copy is in Devanagari").toMatch(/[ऀ-ॿ]/);
      });
    }
  }

  it("descriptions are unique", () => {
    for (const l of ["en", "hi"]) {
      const d = files(l).map((f) => load(l, f).description);
      expect(new Set(d).size).toBe(d.length);
    }
  });
});
