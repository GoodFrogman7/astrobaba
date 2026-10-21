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

/**
 * Personal pages (wallet, chat, account, AI assistant): never indexed, never in the sitemap. `follow: false` keeps
 * crawlers from wandering from a page that only exists for one signed-in person.
 */
export const PRIVATE_PATH_PREFIXES = ["/wallet", "/chat", "/account", "/ai"] as const;

export function privateMetadata(title: string): Metadata {
  return { title: `${title} | ${BRAND_NAME}`, robots: { index: false, follow: false } };
}

/** Article structured data for a /learn page (docs/api/growth.md §3). */
export function articleLd(
  locale: Locale,
  path: string,
  a: {
    headline: string;
    description: string;
    author: string;
    datePublished: string;
    dateModified: string;
  },
): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: a.headline.slice(0, 110),
    description: a.description,
    inLanguage: locale === "hi" ? "hi-IN" : "en-IN",
    datePublished: a.datePublished,
    dateModified: a.dateModified,
    author: { "@type": "Person", name: a.author },
    publisher: { "@type": "Organization", name: BRAND_NAME, url: SITE_URL },
    mainEntityOfPage: localeUrl(locale, path),
  };
}

/** Restrict hreflang alternates to the locales a page exists in (e.g. a one-language article). */
export function onlyLocales(meta: Metadata, path: string, locales: readonly Locale[]): Metadata {
  if (!locales.length) return meta;
  const languages: Record<string, string> = Object.fromEntries(
    locales.map((l) => [l, localeUrl(l, path)]),
  );
  languages["x-default"] = localeUrl(locales.includes("en") ? "en" : locales[0]!, path);
  return { ...meta, alternates: { ...meta.alternates, languages } };
}
