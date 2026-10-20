import { BRAND_NAME, LOCALES, type Locale } from "@astro/shared";
import type { Metadata } from "next";
import { localeUrl, SITE_URL } from "@/site";

/** Metadata for an indexable page: title, description, canonical and hreflang alternates. */
export function pageMetadata(
  locale: Locale,
  path: string,
  { title, description }: { title: string; description: string },
  { index = true }: { index?: boolean } = {},
): Metadata {
  const languages: Record<string, string> = Object.fromEntries(
    LOCALES.map((l) => [l, localeUrl(l, path)]),
  );
  languages["x-default"] = localeUrl("en", path);
  return {
    title: `${title} | ${BRAND_NAME}`,
    description,
    alternates: { canonical: localeUrl(locale, path), languages },
    openGraph: {
      title,
      description,
      url: localeUrl(locale, path),
      siteName: BRAND_NAME,
      locale: locale === "hi" ? "hi_IN" : "en_IN",
      type: "website",
    },
    robots: index ? undefined : { index: false, follow: true },
  };
}

type JsonLdObject = Record<string, unknown>;

export function organizationLd(): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: BRAND_NAME,
    url: SITE_URL,
  };
}

export function breadcrumbLd(
  locale: Locale,
  items: { name: string; path: string }[],
): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: localeUrl(locale, item.path),
    })),
  };
}

export function faqLd(faqs: { q: string; a: string }[]): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };
}
