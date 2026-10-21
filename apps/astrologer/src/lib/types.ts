/** Types for the astrologer console, from docs/api/marketplace.md and docs/api/billing.md. */

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
  /** Null while held: held text may contain contact details. */
  text: string | null;
  created_at: string;
  author_label: string;
  reply: { text: string; at: string } | null;
  session_id: string;
  status: "published" | "held";
}
