/**
 * Consent, privacy and safety shapes. Source of truth: docs/api/trust.md.
 */

export const CONSENT_KINDS = ["age_18", "terms", "privacy", "astrologer_terms"] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];

export interface ConsentState {
  version: string;
  required: ConsentKind[];
  accepted: { kind: ConsentKind; version: string; accepted_at: string }[];
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
  status: "queued" | "ready" | "failed";
  created_at: string;
  download_url: string | null;
}
