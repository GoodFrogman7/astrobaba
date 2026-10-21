import type { Lang } from "./context";

/**
 * System fonts only, the same stacks as the site layout (app/[locale]/layout.tsx). The worker's
 * Chromium must have a Devanagari font installed (Noto Sans Devanagari in our images).
 */
const LATIN_STACK =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Helvetica Neue", Arial';
const DEVANAGARI_STACK =
  '"Noto Sans Devanagari", "Nirmala UI", "Kohinoor Devanagari", "Mangal", "Lohit Devanagari"';

export function fontStack(lang: Lang): string {
  // Hindi puts the Devanagari fonts first so Latin digits inside Hindi text match them.
  return lang === "hi"
    ? `${DEVANAGARI_STACK}, system-ui, sans-serif`
    : `${LATIN_STACK}, ${DEVANAGARI_STACK}, sans-serif`;
}

/** A CSS string literal for generated content (page footers). */
export function cssString(text: string): string {
  return `"${text.replace(/[\\"]/g, "\\$&").replace(/[<>\r\n]/g, "")}"`;
}
