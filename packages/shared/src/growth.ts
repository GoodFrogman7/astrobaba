/** Launch and growth shapes (docs/api/growth.md, Phase 8). */

export const VISITOR_STEPS = [
  "visit",
  "tool_use",
  "otp",
  "free_session",
  "first_recharge",
  "repeat",
] as const;
export type FunnelStepKey = (typeof VISITOR_STEPS)[number];
export const ACCOUNT_STEPS = ["otp", "free_session", "first_recharge", "repeat"] as const;

export const TRAFFIC_SOURCES = ["direct", "search", "social", "referral", "campaign"] as const;
export type TrafficSource = (typeof TRAFFIC_SOURCES)[number];

export interface FunnelStep {
  key: FunnelStepKey;
  /** Strict: the previous step was reached too. */
  count: number;
  /** Reached this step whatever happened before. */
  reached: number;
  /** count / previous step's count; null for the first step or when the previous is 0. */
  rate: number | null;
  target: { low: number; high: number | null } | null;
}

export interface FunnelWeek {
  week_start: string;
  counts: Partial<Record<FunnelStepKey, number>>;
}

export interface BreakdownRow {
  key: string;
  visit: number;
  otp: number;
  first_recharge: number;
}

export interface GrowthFunnel {
  from: string;
  to: string;
  window_days: number;
  generated_at: string;
  visitor: {
    steps: FunnelStep[];
    weeks: FunnelWeek[];
    by_source: BreakdownRow[];
    by_tool: BreakdownRow[];
    by_landing: BreakdownRow[];
  };
  account: { steps: FunnelStep[]; weeks: FunnelWeek[] };
  notes: string[];
}

export interface CoverageRow {
  id: string;
  live: number;
  target_min: number;
}

export interface SupplyReadiness {
  target: { min: number; max: number };
  live: number;
  pipeline: Record<
    "applied" | "kyc_submitted" | "interview" | "probation" | "approved" | "suspended" | "rejected",
    number
  >;
  steps_passed: Record<"identity" | "qualification" | "interview" | "probation", number>;
  languages: CoverageRow[];
  skills: CoverageRow[];
  /** 7 rows (Monday first) of 24 IST hours: live astrologers scheduled. */
  schedule: { hours: number[][]; uncovered_hours: number };
  invites: Record<InviteStatus, number>;
}

export const INVITE_STATUSES = ["open", "used", "expired", "revoked"] as const;
export type InviteStatus = (typeof INVITE_STATUSES)[number];

export interface AstrologerInvite {
  id: string;
  note: string | null;
  status: InviteStatus;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  astrologer_id: string | null;
}

/** Returned once, on creation; the code is never shown again. */
export interface CreatedInvite {
  id: string;
  code: string;
  url: string;
  expires_at: string;
}

export const CONTENT_KINDS = [
  "article",
  "horoscope",
  "tool_page",
  "social",
  "video",
  "other",
] as const;
export const CONTENT_STATUSES = ["idea", "drafting", "review", "scheduled", "published"] as const;
export const CONTENT_LOCALES = ["en", "hi", "both"] as const;

export interface ContentItem {
  id: string;
  title: string;
  kind: (typeof CONTENT_KINDS)[number];
  locale: (typeof CONTENT_LOCALES)[number];
  status: (typeof CONTENT_STATUSES)[number];
  due_date: string | null;
  url: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface AlmanacDate {
  date: string;
  kind: "purnima" | "amavasya" | "ekadashi" | "sun_sign_change";
  tithi?: string;
  sign?: string;
}

export const READINESS_CHECKS = [
  "legal_approved",
  "helplines_verified",
  "jyotish_tables_reviewed",
  "supply_live",
  "supply_languages",
  "horoscopes_today",
  "payments_live",
  "sms_live",
  "email_live",
  "document_storage",
  "reconciliation_recent",
  "jobs_healthy",
  "analytics_flowing",
  "voice_ready",
  "ai_ready",
] as const;

export interface ReadinessCheck {
  id: (typeof READINESS_CHECKS)[number];
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface LaunchReadiness {
  generated_at: string;
  checks: ReadinessCheck[];
}
