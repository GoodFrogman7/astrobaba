import { REPORT_SKUS, type ReportSku } from "@astro/shared";
import productsFile from "../../../../../data/marketplace/products.json" with { type: "json" };

/**
 * One-time product settings the web app explains on screen (data/marketplace/products.json,
 * shared with the API). The API decides every charge. Report prices on public pages come from
 * GET /v1/reports/products; the AI question price is not exposed by an endpoint, so it is read
 * from the same settings file the API charges from (and every AiQuestion echoes `price_paise`).
 */
export const KUNDLIS_PER_SKU: Record<ReportSku, number> = Object.fromEntries(
  REPORT_SKUS.map((s) => [s, productsFile.reports[s].kundlis]),
) as Record<ReportSku, number>;

export const AI_QUESTION = {
  pricePaise: productsFile.ai_question.price_paise,
  maxChars: productsFile.ai_question.max_chars,
} as const;

export const REMEDY_NOTE_MAX = 500;

/**
 * /remedies is public but noindex (and not in the sitemap) until the catalogue has passed
 * editorial and legal review: entries carry `review: needs_editorial_review`
 * (docs/api/revenue.md §4), remedy advertising needs the Phase 7 legal check (Drugs and Magic
 * Remedies Act, ASCI), and an empty or short catalogue would be a thin page. See
 * docs/ARCHITECTURE.md "Reports, AI and remedies in the web app".
 */
export const REMEDIES_INDEXABLE = false;
