import "server-only";

import { REPORT_SKUS } from "@astro/shared";
import { API_URL } from "@/lib/upstream";
import type { Remedy, ReportProduct } from "./types";

/** Public pages are rebuilt at most this often (ISR), so prices and the catalogue stay fresh. */
export const REVALIDATE_S = 600;

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`${API_URL}${path}`, {
    next: { revalidate: REVALIDATE_S },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

/**
 * Report products and prices from GET /v1/reports/products. Null when the API cannot be
 * reached: the page then says the price is shown at checkout instead of printing a number.
 */
export async function loadReportProducts(): Promise<ReportProduct[] | null> {
  try {
    const body = (await getJson("/v1/reports/products")) as { items?: unknown };
    if (!Array.isArray(body.items)) return null;
    return (body.items as ReportProduct[]).filter(
      (p) =>
        REPORT_SKUS.includes(p.sku) &&
        Number.isInteger(p.price_paise) &&
        p.price_paise > 0 &&
        Array.isArray(p.languages),
    );
  } catch {
    return null;
  }
}

/** Active remedies catalogue (GET /v1/remedies), `{items}` or a bare list. Null on failure. */
export async function loadRemedies(): Promise<Remedy[] | null> {
  try {
    const body = await getJson("/v1/remedies");
    const items = Array.isArray(body) ? body : (body as { items?: unknown }).items;
    if (!Array.isArray(items)) return null;
    return (items as Remedy[]).filter(
      (r) => typeof r.id === "string" && r.name && r.description && r.price_note,
    );
  } catch {
    return null;
  }
}
