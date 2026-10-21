import { localeUrl } from "@/site";
import { languageName, skillName } from "./taxonomy";
import type { AstrologerProfile } from "./types";

/**
 * Person structured data for a public profile. No aggregateRating: self-hosted reviews are not
 * eligible for review rich results, and we do not want to look like rich-result spam.
 */
export function personLd(p: AstrologerProfile, locale: "en" | "hi"): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Person",
    name: p.display_name,
    url: localeUrl(locale, `/astrologers/${p.slug}`),
    jobTitle: locale === "hi" ? "ज्योतिषी" : "Astrologer",
    knowsAbout: p.skills.map((s) => skillName(s, locale)),
    knowsLanguage: p.languages.map((l) => ({
      "@type": "Language",
      name: languageName(l, "en"),
      alternateName: l,
    })),
  };
}
