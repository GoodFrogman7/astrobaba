import { BRAND_NAME, type Locale } from "@astro/shared";
import { localeUrl } from "@/site";
import type { ReportProduct } from "./types";

/**
 * schema.org Product + Offer for a report, only when the API gave us a price (never a guessed
 * one). seo-check validates every JSON-LD block and requires Organization + BreadcrumbList,
 * which the layout and PageShell add; Product is an extra block.
 */
export function reportProductLd(
  locale: Locale,
  p: ReportProduct,
  text: { name: string; description: string },
): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: text.name,
    description: text.description,
    sku: p.sku,
    brand: { "@type": "Brand", name: BRAND_NAME },
    offers: {
      "@type": "Offer",
      price: (p.price_paise / 100).toFixed(2),
      priceCurrency: "INR",
      availability: "https://schema.org/InStock",
      url: localeUrl(locale, "/reports"),
    },
  };
}
