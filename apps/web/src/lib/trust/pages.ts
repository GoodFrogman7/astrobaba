/** The policy and help pages (Phase 7) and their public paths. */
export const LEGAL_PAGES = [
  "terms",
  "privacy",
  "refunds",
  "credit",
  "grievance",
  "safety",
] as const;
export type LegalPageKey = (typeof LEGAL_PAGES)[number];

/** Public path of each legal page (identical in every locale; Hindi adds /hi). */
export const LEGAL_PATHS: Record<LegalPageKey, string> = {
  terms: "/terms",
  privacy: "/privacy",
  refunds: "/refund-policy",
  credit: "/credit-policy",
  grievance: "/grievance",
  safety: "/safety",
};
