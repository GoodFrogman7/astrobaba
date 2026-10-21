import "server-only";

import type { Locale } from "@astro/shared";
import type { LegalPageKey } from "./pages";

/**
 * Legal and safety texts (Phase 7): one JSON file per page and locale under
 * src/content/{locale}/legal/. They are plain drafts that describe only what the code does
 * (docs/api/*.md). A section the lawyer must complete carries `lawyer` (what is missing), shown
 * on the page until a lawyer approves the text. `slot` places a block computed from data
 * (processors, refund rules, helplines…) after that section's paragraphs.
 */
export interface LegalSection {
  id: string;
  heading: string;
  body: string[];
  slot?: string;
  lawyer?: string;
}

export interface LegalContent {
  title: string;
  description: string;
  h1: string;
  intro: string;
  sections: LegalSection[];
}

export async function getLegalContent(locale: Locale, key: LegalPageKey): Promise<LegalContent> {
  const mod = (await import(`../../content/${locale}/legal/${key}.json`)) as {
    default: LegalContent;
  };
  return mod.default;
}

/** Fill {placeholders} with values computed from configuration. */
export function fillLegal(c: LegalContent, values: Record<string, string | number>): LegalContent {
  const f = (s: string) => s.replace(/\{(\w+)\}/g, (m, k: string) => String(values[k] ?? m));
  return {
    title: f(c.title),
    description: f(c.description),
    h1: f(c.h1),
    intro: f(c.intro),
    sections: c.sections.map((s) => ({
      ...s,
      heading: f(s.heading),
      body: s.body.map(f),
      ...(s.lawyer ? { lawyer: f(s.lawyer) } : {}),
    })),
  };
}
