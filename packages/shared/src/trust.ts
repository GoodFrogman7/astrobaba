/**
 * Consent, privacy and safety shapes. Source of truth: docs/api/trust.md.
 */

export const CONSENT_KINDS = ["age_18", "terms", "privacy", "astrologer_terms"] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];

export interface ConsentState {
  version: string;
  /** Every kind this user's roles need. */
  required: ConsentKind[];
  /** Required kinds not yet accepted for the current version. */
  missing: ConsentKind[];
  accepted: { kind: ConsentKind; version: string; accepted_at: string }[];
  /** True when `missing` is empty. */
  current: boolean;
}

export interface Helpline {
  id: string;
  name: { en: string; hi: string };
  number: string;
  hours: { en: string; hi: string };
  official_site: string;
}

export interface SafetyResources {
  helplines: Helpline[];
  not_a_helpline: { en: string; hi: string };
}

export const ASTROLOGER_REPORT_REASONS = [
  "harassment",
  "scam",
  "fear_selling",
  "medical_claims",
  "off_platform",
  "other",
] as const;
export type AstrologerReportReason = (typeof ASTROLOGER_REPORT_REASONS)[number];

export interface DataExport {
  id: string;
  status: "queued" | "ready" | "failed" | "expired";
  created_at: string;
  /** Ready files are removed after this time. */
  expires_at: string | null;
  download_url: string | null;
}
