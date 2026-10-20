import "server-only";

import type { Locale } from "@astro/shared";

/**
 * Editorial copy for a page, one JSON file per page and locale: src/content/{locale}/{key}.json.
 * Copy explains what a value means and how it is calculated. It never states an astro value
 * (those come from the engine) and never promises outcomes (PLAN.md §7 Phase 7 policy).
 */
export interface PageContent {
  title: string; // <title>, without the brand suffix
  description: string; // meta description, 50–160 characters
  h1: string;
  intro: string;
  sections: { heading: string; body: string[] }[];
  faqs: { q: string; a: string }[]; // 4–6 per page (PLAN.md §5 Phase 2)
}

export async function getContent(locale: Locale, key: string): Promise<PageContent> {
  const mod = (await import(`../content/${locale}/${key}.json`)) as { default: PageContent };
  return mod.default;
}

/** Fill {placeholders} in copy (e.g. {city}, {date}) with computed values. */
export function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);
}

export function fillContent(c: PageContent, values: Record<string, string>): PageContent {
  const f = (s: string) => fill(s, values);
  return {
    title: f(c.title),
    description: f(c.description),
    h1: f(c.h1),
    intro: f(c.intro),
    sections: c.sections.map((s) => ({ heading: f(s.heading), body: s.body.map(f) })),
    faqs: c.faqs.map((q) => ({ q: f(q.q), a: f(q.a) })),
  };
}
