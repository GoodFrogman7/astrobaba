import { DISCLAIMER } from "@astro/shared";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import enCore from "../messages/en.json" with { type: "json" };
import enGrowth from "../messages/en/growth.json" with { type: "json" };
import enTools from "../messages/en/tools.json" with { type: "json" };
import hiCore from "../messages/hi.json" with { type: "json" };
import hiGrowth from "../messages/hi/growth.json" with { type: "json" };
import hiTools from "../messages/hi/tools.json" with { type: "json" };

const MESSAGES = {
  en: { ...enCore, ...enTools, ...enGrowth },
  hi: { ...hiCore, ...hiTools, ...hiGrowth },
};
const FIXTURES = fileURLToPath(new URL("./fixtures/learn/", import.meta.url));

vi.mock("server-only", () => ({}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next-intl/server", async () => {
  const { createTranslator: make } = await import("next-intl");
  return {
    getTranslations: async ({ locale, namespace }: { locale: "en" | "hi"; namespace?: string }) =>
      make({ locale, messages: MESSAGES[locale], namespace: namespace as never }),
    setRequestLocale: () => undefined,
  };
});
vi.mock("@/lib/marketplace/data", () => ({
  sitemapSlugs: async () => [],
  featuredAstrologers: async () => [],
}));
// The site ships no articles: every page and sitemap test reads the fixture files instead.
let root = FIXTURES;
vi.mock("@/lib/learn", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/learn")>();
  return { ...real, learnSource: () => real.fileArticleSource(root) };
});

import LearnArticle, {
  generateMetadata as articleMeta,
  generateStaticParams,
} from "../src/app/[locale]/learn/[slug]/page";
import LearnIndex, { generateMetadata as indexMeta } from "../src/app/[locale]/learn/page";
import sitemap from "../src/app/sitemap";
import {
  CONTENT_ROOT,
  fileArticleSource,
  isPublished,
  parseArticle,
  type Article,
} from "../src/lib/learn";

type Locale = "en" | "hi";

async function render(node: ReactNode, locale: Locale = "en") {
  const stream = await renderToReadableStream(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone="Asia/Kolkata">
      {node}
    </NextIntlClientProvider>,
  );
  await stream.allReady;
  return new Response(stream).text();
}

const params = <T,>(p: T) => ({ params: Promise.resolve(p) });

function ldTypes(html: string): unknown[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(
    (m) => JSON.parse(m[1]!) as unknown,
  );
}

describe("article loader", () => {
  const src = fileArticleSource(FIXTURES);

  it("exposes only published articles with a named reviewer", () => {
    expect(src.list("en").map((a) => a.slug)).toEqual([
      "fixture-english-only",
      "fixture-published",
    ]);
    expect(src.list("hi").map((a) => a.slug)).toEqual(["fixture-published"]);
    expect(src.get("en", "fixture-draft")).toBeNull();
    expect(src.get("en", "fixture-unreviewed")).toBeNull();
    expect(src.get("hi", "fixture-draft")).toBeNull();
    // A file whose slug does not match its name is ignored, under either name.
    expect(src.get("en", "fixture-wrong-slug")).toBeNull();
    expect(src.get("en", "some-other-slug")).toBeNull();
    expect(src.get("en", "../../etc/passwd")).toBeNull();
    expect(src.locales("fixture-published")).toEqual(["en", "hi"]);
    expect(src.locales("fixture-english-only")).toEqual(["en"]);
  });

  it("drops unknown related tools", () => {
    expect(src.get("en", "fixture-published")!.related_tools).toEqual([
      "kundli",
      "nakshatra",
      "kundli-matching",
    ]);
  });

  it("checks the shape and the publication rules", () => {
    const raw = JSON.parse(
      readFileSync(join(FIXTURES, "en/learn/fixture-published.json"), "utf8"),
    ) as Article;
    expect(isPublished(parseArticle(raw, "fixture-published")!)).toBe(true);
    expect(parseArticle(raw, "another-name")).toBeNull();
    expect(parseArticle({ ...raw, status: "live" }, raw.slug)).toBeNull();
    expect(parseArticle({ ...raw, sections: [{ heading: "x", body: [""] }] }, raw.slug)).toBeNull();
    expect(parseArticle({ ...raw, title: "" }, raw.slug)).toBeNull();
    const p = (over: Partial<Article>) => isPublished(parseArticle({ ...raw, ...over }, raw.slug)!);
    expect(p({ reviewed_by: "" })).toBe(false);
    expect(p({ reviewed_by: "   " })).toBe(false);
    expect(p({ status: "draft" })).toBe(false);
    expect(p({ published_at: "soon" })).toBe(false);
    expect(p({ author: "" })).toBe(false);
  });

  it("skips files that are not JSON, and a missing folder means no articles", () => {
    const dir = mkdtempSync(join(tmpdir(), "learn-"));
    mkdirSync(join(dir, "en", "learn"), { recursive: true });
    writeFileSync(join(dir, "en", "learn", "broken.json"), "{ not json");
    expect(fileArticleSource(dir).list("en")).toEqual([]);
    expect(fileArticleSource(dir).list("hi")).toEqual([]);
  });

  it("the site's own article files are all well formed", () => {
    for (const locale of ["en", "hi"] as const) {
      let files: string[] = [];
      try {
        files = readdirSync(join(CONTENT_ROOT, locale, "learn")).filter((f) => f.endsWith(".json"));
      } catch {
        continue; // no articles yet (this phase ships none)
      }
      for (const f of files) {
        const a = parseArticle(
          JSON.parse(readFileSync(join(CONTENT_ROOT, locale, "learn", f), "utf8")),
          f.slice(0, -5),
        );
        expect(a, `${locale}/learn/${f}`).not.toBeNull();
      }
    }
  });
});

describe("/learn pages", () => {
  it("build only published articles", () => {
    expect(generateStaticParams()).toEqual([
      { locale: "en", slug: "fixture-english-only" },
      { locale: "en", slug: "fixture-published" },
      { locale: "hi", slug: "fixture-published" },
    ]);
  });

  it("render an article with Article JSON-LD, breadcrumbs, the disclaimer and tool links", async () => {
    const html = await render(
      await LearnArticle(params({ locale: "en", slug: "fixture-published" })),
    );
    expect(html).toContain("<h1");
    expect(html).toContain("Fixture article fixture-published");
    expect(html).toContain("By Fixture Author");
    expect(html).toContain("Reviewed by Fixture Reviewer");
    expect(html).toContain('dateTime="2026-10-01"');
    expect(html).toContain('data-testid="article-disclaimer"');
    expect(html).toContain(DISCLAIMER.en);
    expect(html).toContain('href="/kundli"');
    expect(html).toContain('href="/tools/nakshatra"');
    expect(html).toContain('href="/kundli-matching"');
    const ld = ldTypes(html) as Record<string, unknown>[];
    const article = ld.find((d) => d["@type"] === "Article")!;
    expect(article).toMatchObject({
      headline: "Fixture article fixture-published",
      inLanguage: "en-IN",
      datePublished: "2026-10-01",
      dateModified: "2026-10-15",
      author: { "@type": "Person", name: "Fixture Author" },
    });
    expect(String(article.mainEntityOfPage)).toMatch(/\/learn\/fixture-published$/);
    expect(ld.some((d) => d["@type"] === "BreadcrumbList")).toBe(true);
  });

  it("render the Hindi article in Hindi", async () => {
    const html = await render(
      await LearnArticle(params({ locale: "hi", slug: "fixture-published" })),
      "hi",
    );
    expect(html).toContain(DISCLAIMER.hi);
    expect(html).toContain("जाँचकर्ता: नमूना जाँचकर्ता");
    expect(html).toContain('"inLanguage":"hi-IN"');
  });

  it("404 for drafts, unreviewed files, missing translations and unknown slugs", async () => {
    for (const [locale, slug] of [
      ["en", "fixture-draft"],
      ["en", "fixture-unreviewed"],
      ["hi", "fixture-english-only"],
      ["en", "nope"],
    ] as const)
      await expect(LearnArticle(params({ locale, slug }))).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("set canonical and hreflang for the locales the article exists in", async () => {
    const both = await articleMeta(params({ locale: "hi", slug: "fixture-published" }));
    expect(String(both.alternates?.canonical)).toMatch(/\/hi\/learn\/fixture-published$/);
    expect(Object.keys(both.alternates?.languages ?? {}).sort()).toEqual(["en", "hi", "x-default"]);
    expect(both.openGraph).toMatchObject({ type: "article", publishedTime: "2026-10-01" });
    const one = await articleMeta(params({ locale: "en", slug: "fixture-english-only" }));
    expect(Object.keys(one.alternates?.languages ?? {}).sort()).toEqual(["en", "x-default"]);
    expect(await articleMeta(params({ locale: "en", slug: "fixture-draft" }))).toEqual({});
  });

  it("list published articles, newest first", async () => {
    const html = await render(await LearnIndex(params({ locale: "en" })));
    expect(html).toContain(enGrowth.growth.learn.h1);
    expect(html.indexOf("fixture-english-only")).toBeLessThan(html.indexOf("fixture-published"));
    expect(html).not.toContain("fixture-draft");
    expect(html).not.toContain("fixture-unreviewed");
    const meta = await indexMeta(params({ locale: "en" }));
    expect(String(meta.alternates?.canonical)).toMatch(/\/learn$/);
  });

  it("/learn is 404 when nothing is published", async () => {
    root = mkdtempSync(join(tmpdir(), "learn-empty-"));
    try {
      await expect(LearnIndex(params({ locale: "en" }))).rejects.toThrow("NEXT_NOT_FOUND");
      expect(await indexMeta(params({ locale: "hi" }))).toEqual({});
      const urls = (await sitemap()).map((e) => e.url);
      expect(urls.some((u) => u.includes("/learn"))).toBe(false);
    } finally {
      root = FIXTURES;
    }
  });
});

describe("sitemap", () => {
  it("lists published articles in their own locales, with lastmod", async () => {
    const entries = await sitemap();
    const learn = entries.filter((e) => e.url.includes("/learn"));
    expect(learn.map((e) => new URL(e.url).pathname).sort()).toEqual([
      "/hi/learn",
      "/hi/learn/fixture-published",
      "/learn",
      "/learn/fixture-english-only",
      "/learn/fixture-published",
    ]);
    const only = learn.find((e) => e.url.endsWith("/learn/fixture-english-only"))!;
    expect(Object.keys(only.alternates?.languages ?? {})).toEqual(["en"]);
    expect(only.lastModified).toBe("2026-10-10");
    const both = learn.find((e) => e.url.endsWith("/hi/learn/fixture-published"))!;
    expect(Object.keys(both.alternates?.languages ?? {})).toEqual(["en", "hi"]);
    expect(both.lastModified).toBe("2026-10-15");
    expect(entries.some((e) => /fixture-(draft|unreviewed)|some-other-slug/.test(e.url))).toBe(
      false,
    );
    // Everything else is still listed in both languages.
    expect(entries.filter((e) => new URL(e.url).pathname === "/kundli")).toHaveLength(1);
    expect(entries.filter((e) => new URL(e.url).pathname === "/hi/kundli")).toHaveLength(1);
  });
});
