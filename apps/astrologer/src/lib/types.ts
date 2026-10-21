/** Types for the astrologer console, from docs/api/marketplace.md and docs/api/billing.md. */
import type { SessionView } from "@astro/shared";

export type AstrologerStatus =
  "applied" | "kyc_submitted" | "interview" | "probation" | "approved" | "suspended" | "rejected";

/** `GET /v1/me`. The phone arrives masked and is never shown in the console. */
export interface Me {
  id: string;
  phone?: string;
  locale?: string;
  roles?: string[];
  astrologer: { id: string; status: AstrologerStatus; slug: string | null } | null;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export type SessionPage = Page<SessionView>;

/* ---- Portal (Phase 5, docs/api/portal.md §2) ---- */

/** `GET /v1/astrologer/me`: only the fields the portal shows (price and tier are admin-set). */
export interface AstrologerProfile {
  id: string;
  display_name?: string;
  tier?: string | null;
  price_per_min_paise?: number | null;
}

/** `GET /v1/astrologer/me/balance`. */
export interface Balance {
  payable_paise: number;
  last_payout: { period: string; net_paise: number; paid_at: string | null } | null;
}

/** `GET /v1/astrologer/me/reviews` item: a Review plus session and moderation status. */
export interface PortalReview {
  id: string;
  rating: number;
  text: string;
  created_at: string;
  author_label?: string;
  reply: { text: string; at: string } | null;
  session_id: string | null;
  /** "published", or a held state ("flagged", "held", "pending_moderation"). */
  status: string;
}

/** A payout adjustment line. Its shape is not fixed by the contract yet, so read tolerantly. */
export interface PayoutAdjustment {
  amount_paise?: number;
  kind?: string;
  note?: string | null;
  description?: string | null;
  reason?: string | null;
}
