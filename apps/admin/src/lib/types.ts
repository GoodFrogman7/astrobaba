/** Types for the admin console, from docs/api/marketplace.md and the horoscope admin API. */

export type AstrologerStatus =
  "applied" | "kyc_submitted" | "interview" | "probation" | "approved" | "suspended" | "rejected";

export const STATUSES: AstrologerStatus[] = [
  "applied",
  "kyc_submitted",
  "interview",
  "probation",
  "approved",
  "suspended",
  "rejected",
];

export type Step = "identity" | "qualification" | "interview" | "probation";
export const STEPS: Step[] = ["identity", "qualification", "interview", "probation"];
export type StepStatus = "pending" | "passed" | "failed";

export interface Verification {
  step: Step;
  status: StepStatus;
  note: string | null;
  at: string | null;
  reviewer?: string | null;
}

export interface KycDocument {
  id: string;
  kind: "identity" | "qualification" | "other";
  filename: string;
  size: number;
  content_type?: string;
  uploaded_at: string;
  review_status?: string;
}

export interface Flags {
  chat_enabled: boolean;
  call_enabled: boolean;
  show_in_directory: boolean;
}

export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  detail?: Record<string, unknown> | null;
}

export interface AdminAstrologerRow {
  id: string;
  slug: string | null;
  display_name: string;
  status: AstrologerStatus;
  tier: string | null;
  created_at: string;
  is_seed: boolean;
  price_per_min_paise?: number | null;
  requested_price_per_min_paise?: number;
  verifications?: Record<string, StepStatus> | Verification[];
  documents_count?: number;
}

export interface AdminAstrologer extends Omit<AdminAstrologerRow, "verifications"> {
  phone: string | null; // masked by the API
  bio: string;
  bio_hi: string | null;
  skills: string[];
  languages: string[];
  gender: string;
  experience_years: number;
  requested_price_per_min_paise: number;
  price_per_min_paise: number | null;
  flags: Flags;
  documents: KycDocument[];
  verifications: Verification[];
  audit: AuditEntry[];
  suspended_reason?: string | null;
  rejected_reason?: string | null;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
  total?: number;
}

export interface AdminReview {
  id: string;
  rating: number;
  text: string;
  status: "published" | "flagged" | "hidden";
  created_at: string;
  report_count: number;
  astrologer: { id: string; slug: string | null; display_name: string } | null;
  held?: boolean;
  auto_flag_reason?: string | null;
  reply?: { text: string; at: string } | null;
  moderation_note?: string | null;
}

export interface Tier {
  id: string;
  en: string;
  min_price_per_min_paise: number;
  max_price_per_min_paise: number;
}

export interface Taxonomy {
  skills: { id: string; en: string }[];
  languages: { id: string; en: string }[];
  genders: { id: string; en: string }[];
  tiers: Tier[];
}

export const AREAS = ["overall", "love", "career", "money", "health"] as const;
export type Area = (typeof AREAS)[number];
export type Sections = Record<Area, string>;

export interface HoroscopeEntry {
  id: string;
  period: "daily" | "weekly" | "monthly";
  sign: string;
  locale: string;
  window: { start_ist_date: string; end_ist_date: string };
  sections: Sections;
  scores: Record<string, { score: number; label: string }> | null;
  lucky: { day: string; number: number } | null;
  status: "pending_review" | "published" | "rejected";
  facts: {
    transits?: { graha: string; sign: string; house_from_sign: number; retrograde: boolean }[];
    areas?: Record<string, { score: number; label: string }>;
  } | null;
  model: string;
  prompt_version: string;
  created_at: string;
}

export interface Me {
  id: string;
  phone: string;
  roles?: string[];
}
