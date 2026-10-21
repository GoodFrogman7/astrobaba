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
  net_paise: number;
  carried_forward_paise: number;
  sessions: number;
  minutes: number;
  generated_at: string;
  approved_at: string | null;
  paid_at: string | null;
  reference: string | null;
}
