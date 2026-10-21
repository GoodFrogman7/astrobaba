import "server-only";

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { LOCALES, type Locale } from "@astro/shared";
import { TOOLS } from "@/lib/tools/registry";

/**
 * /learn articles (docs/api/growth.md §3): one JSON file per article and locale,
 * src/content/{locale}/learn/{slug}.json. `sections` uses the same blocks as the other content
 * files. Only `published` files with a non-empty `reviewed_by` are routed, listed and put in
 * the sitemap; drafts, unreviewed and malformed files are invisible. No articles ship with the
 * code: the founder writes and reviews them. Astro values in an article must come from the
 * engine or /data, never typed from memory.
 */
export interface Article {
  slug: string;
  status: "draft" | "published";
  title: string; // <title>, without the brand suffix
  description: string; // meta description
  h1: string;
  intro: string;
  sections: { heading: string; body: string[] }[];
  related_tools: string[];
  author: string;
  reviewed_by: string;
  published_at: string; // YYYY-MM-DD (IST)
  updated_at: string; // YYYY-MM-DD (IST)
}

/** Tools an article may link to, and where they live. */
export const TOOL_HREFS: Record<string, string> = {
  kundli: "/kundli",
  "kundli-matching": "/kundli-matching",
  ...Object.fromEntries(TOOLS.map((t) => [t.slug, `/tools/${t.slug}`])),
};

export const ARTICLE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const str = (v: unknown): v is string => typeof v === "string";
const nonEmpty = (v: unknown): v is string => str(v) && v.trim().length > 0;
const validDate = (v: unknown): v is string =>
  str(v) && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

/** A well-formed article file, or null. `fileSlug` is the file name without .json. */
export function parseArticle(raw: unknown, fileSlug: string): Article | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  if (a.slug !== fileSlug || !ARTICLE_SLUG.test(fileSlug) || fileSlug.length > 80) return null;
  if (a.status !== "draft" && a.status !== "published") return null;
  for (const k of ["title", "description", "h1", "intro"] as const)
    if (!nonEmpty(a[k])) return null;
  for (const k of ["author", "reviewed_by", "published_at", "updated_at"] as const)
    if (!str(a[k])) return null;
  if (!Array.isArray(a.sections)) return null;
  const sections: Article["sections"] = [];
  for (const s of a.sections) {
    const x = (s ?? {}) as Record<string, unknown>;
    if (!nonEmpty(x.heading) || !Array.isArray(x.body) || !x.body.every(nonEmpty)) return null;
    sections.push({ heading: x.heading, body: x.body as string[] });
  }
  if (!Array.isArray(a.related_tools) || !a.related_tools.every(str)) return null;
  return {
    slug: fileSlug,
    status: a.status,
    title: a.title as string,
    description: a.description as string,
    h1: a.h1 as string,
    intro: a.intro as string,
    sections,
    related_tools: (a.related_tools as string[]).filter((t) => t in TOOL_HREFS),
    author: a.author as string,
    reviewed_by: a.reviewed_by as string,
    published_at: a.published_at as string,
    updated_at: a.updated_at as string,
  };
}

/** Routed: published, reviewed by a named person, with real dates. */
export function isPublished(a: Article): boolean {
  return (
    a.status === "published" &&
    a.reviewed_by.trim().length > 0 &&
    a.author.trim().length > 0 &&
    a.sections.length > 0 &&
    validDate(a.published_at) &&
    validDate(a.updated_at)
  );
}

export interface ArticleSource {
  /** Published articles in a locale, newest first. */
  list(locale: Locale): Article[];
  /** One published article, or null (drafts and unreviewed files are null too). */
  get(locale: Locale, slug: string): Article | null;
  /** Locales in which this slug is published. */
  locales(slug: string): Locale[];
}

function readLocale(root: string, locale: Locale): Article[] {
  const dir = path.join(root, locale, "learn");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return []; // no articles in this locale yet
  }
  const out: Article[] = [];
  for (const f of files.sort()) {
    try {
      const a = parseArticle(JSON.parse(readFileSync(path.join(dir, f), "utf8")), f.slice(0, -5));
      if (a && isPublished(a)) out.push(a);
    } catch {
      /* unreadable or not JSON: not routed */
    }
  }
  return out.sort(
    (x, y) => y.published_at.localeCompare(x.published_at) || x.slug.localeCompare(y.slug),
  );
}

/** Articles under `root` ({root}/{locale}/learn/*.json). */
export function fileArticleSource(root: string): ArticleSource {
  const list = (locale: Locale) => readLocale(root, locale);
  return {
    list,
    get: (locale, slug) =>
      ARTICLE_SLUG.test(slug) ? (list(locale).find((a) => a.slug === slug) ?? null) : null,
    locales: (slug) => LOCALES.filter((l) => list(l).some((a) => a.slug === slug)),
  };
}

export const CONTENT_ROOT = path.join(process.cwd(), "src", "content");

/** The site's articles. Tests replace this to read fixture files. */
export function learnSource(): ArticleSource {
  return fileArticleSource(CONTENT_ROOT);
}
