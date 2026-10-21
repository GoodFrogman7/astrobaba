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

/* ---- Money and sessions (Phase 4, docs/api/billing.md "Admin") ---- */

export interface PromoLot {
  id: string;
  remaining_paise: number;
  expires_at: string;
  campaign: string | null;
}

export interface Wallet {
  real_paise: number;
  promo_paise: number;
  total_paise: number;
  promo_lots: PromoLot[];
  free_session: { enabled: boolean; eligible: boolean; minutes: number; reason: string | null };
}

export type WalletTxnKind =
  | "recharge"
  | "recharge_bonus"
  | "consultation"
  | "refund"
  | "free_session_grant"
  | "promo_expiry"
  | "adjustment";

export interface WalletTxn {
  id: string;
  kind: WalletTxnKind | string;
  /** Signed from the user's view: credit positive. */
  amount_paise: number;
  real_paise: number;
  promo_paise: number;
  created_at: string;
  session_id: string | null;
  astrologer: { slug: string; display_name: string } | null;
}

export interface AdminWalletView {
  wallet: Wallet;
  transactions: WalletTxn[];
}

export interface AdminRefund {
  id: string;
  /** Rule name (failed_connect, astrologer_drop, low_rating, …) or "manual". */
  rule: string;
  session_id: string | null;
  user_id?: string | null;
  amount_paise: number;
  /** "system" for rules, else the admin who issued it (masked or id, never a phone in clear). */
  actor: string | null;
  note?: string | null;
  created_at: string;
}

export interface FreeSessionClaim {
  user_id: string;
  session_id: string | null;
  claimed_at: string | null;
  abuse_score: number;
  /** Why the score is what it is (codes like shared_device, ip_burst); never raw phone/IP. */
  reason: string | null;
  reasons?: string[];
  flagged: boolean;
  status?: string | null;
  override?: {
    action: "allow" | "block" | "reset";
    note: string | null;
    actor: string | null;
    at: string;
  } | null;
}

export type ReconStatus = "ok" | "drift" | "error";

export interface ReconCheck {
  name: string;
  status: ReconStatus | string;
  drift_paise?: number | null;
  detail?: string | null;
}

export interface ReconRun {
  id?: string;
  date: string;
  status: ReconStatus;
  drift_paise: number;
  checks: (ReconCheck | string)[];
  started_at?: string | null;
  finished_at?: string | null;
}

/** `GET /v1/admin/sessions`: like SessionView, never any message content. */
export interface AdminSession {
  id: string;
  kind: string;
  status: string;
  end_reason: string | null;
  user_id?: string | null;
  client_label?: string | null;
  astrologer: { id: string; slug: string | null; display_name: string } | null;
  price_per_min_paise: number;
  is_free: boolean;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  billed_minutes: number;
  billed_paise: number;
}
