import type { Locale } from "./locales";

/**
 * Shown on every page and every consultation screen (PLAN.md §5 Phase 2, §6).
 * The Hindi text needs a native-speaker review before launch.
 */
export const DISCLAIMER: Record<Locale, string> = {
  en: "For guidance and entertainment. Not medical, legal or financial advice.",
  hi: "केवल मार्गदर्शन और मनोरंजन के लिए। यह चिकित्सा, कानूनी या वित्तीय सलाह नहीं है।",
};

/** Label for any AI-generated answer. AI is never presented as a human astrologer. */
export const AI_LABEL: Record<Locale, string> = {
  en: "AI assistant",
  hi: "एआई सहायक",
};
