/**
 * Astrologer portal and payout shapes. Source of truth: docs/api/portal.md. Money is integer
 * paise; dates and schedule times are IST.
 */

export const IST_ZONE = "Asia/Kolkata";

/** 0 = Monday … 6 = Sunday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface AvailabilitySlot {
  weekday: Weekday;
  /** "HH:MM", 15-minute steps, IST. */
  start: string;
  end: string;
}

export interface Availability {
  timezone: typeof IST_ZONE;
  slots: AvailabilitySlot[];
}

export const AVAILABILITY_LIMITS = { maxSlots: 21, stepMinutes: 15 } as const;

export interface ConsultSettings {
  chat_enabled: boolean;
  call_enabled: boolean;
  voice_calls_available: boolean;
}

export interface EarningTotals {
  gross_paise: number;
  commission_paise: number;
  refunds_paise: number;
  net_paise: number;
  sessions: number;
  minutes: number;
}

export interface EarningRow {
  session_id: string;
  kind: "chat" | "call";
  started_at: string | null;
  ended_at: string | null;
  billed_minutes: number;
  gross_paise: number;
  commission_paise: number;
  refunds_paise: number;
  net_paise: number;
  client_label: string;
}

export interface Earnings {
  from: string;
  to: string;
  totals: EarningTotals;
  by_day: (EarningTotals & { date: string })[];
  sessions: { items: EarningRow[]; next_cursor: string | null };
}

export const PAYOUT_STATUSES = ["draft", "approved", "paid", "void"] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export interface Payout {
  id: string;
  /** "YYYY-MM" (IST month). */
  period: string;
  status: PayoutStatus;
  gross_paise: number;
  commission_paise: number;
  refunds_paise: number;
  /** Earned before this period and not yet paid (void earlier payouts, a debt is negative). */
  carried_in_paise: number;
  /** gross − commission − refunds + carried_in. */
  net_paise: number;
  /** Set on void payouts: the amount rolled into the next period. */
  carried_forward_paise: number;
  void_reason: "below_minimum" | "admin" | null;
  sessions: number;
  minutes: number;
  generated_at: string;
  approved_at: string | null;
  paid_at: string | null;
  /** IST date the bank transfer was made. */
  paid_on: string | null;
  /** Bank UTR, paid only. */
  reference: string | null;
  /** States that TDS and GST are not modelled yet (a CA decides). */
  tax_note: string;
}

export interface PayoutAdjustment {
  kind: "carried_forward_in" | "carried_forward_out";
  amount_paise: number;
  period: string;
}

/** `POST /v1/admin/payouts/generate` result (counts). */
export interface PayoutGenerateResult {
  period: string;
  generated: number;
  updated: number;
  skipped: number;
  carried_forward: number;
}
