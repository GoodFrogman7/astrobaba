/** Wallet shapes from docs/api/billing.md. Money is integer paise. */
export interface PromoLot {
  id: string;
  remaining_paise: number;
  expires_at: string;
  campaign: string;
}

export interface FreeSessionStatus {
  enabled: boolean;
  eligible: boolean;
  minutes: number;
  reason: string | null;
}

export interface Wallet {
  real_paise: number;
  promo_paise: number;
  total_paise: number;
  promo_lots: PromoLot[];
  free_session: FreeSessionStatus;
}

export const TXN_KINDS = [
  "recharge",
  "recharge_bonus",
  "consultation",
  "purchase",
  "refund",
  "free_session_grant",
  "promo_expiry",
  "adjustment",
] as const;
export type TxnKind = (typeof TXN_KINDS)[number];

export interface WalletTxn {
  id: string;
  kind: TxnKind;
  /** Signed from the user's view: credits positive. */
  amount_paise: number;
  real_paise: number;
  promo_paise: number;
  created_at: string;
  session_id: string | null;
  astrologer: { slug: string; display_name: string } | null;
  /**
   * For `purchase` rows: what was bought, when the API says so (docs/api/revenue.md products).
   * Not in billing.md yet; without it the row is labelled "Purchase".
   */
  product?: "report" | "ai_question" | null;
}

export interface TxnPage {
  items: WalletTxn[];
  next_cursor: string | null;
}

export interface RechargeOptions {
  currency: string;
  min_paise: number;
  max_paise: number;
  packs: { amount_paise: number; bonus_paise: number }[];
  bonus_enabled: boolean;
  provider: "razorpay" | "fake";
  key_id: string;
}

export interface RechargeOrder {
  id: string;
  status: "created" | "paid" | "failed";
  amount_paise: number;
  bonus_paise: number;
  currency: string;
  provider: "razorpay" | "fake";
  provider_order_id: string;
  key_id: string;
  created_at: string;
  paid_at: string | null;
}

/** What our route handlers return for an API error: the detail fields, flattened. */
export interface ApiErrorBody {
  code: string;
  message?: string;
  [extra: string]: unknown;
}

/** GET /api/wallet: signed-out is an expected state, not an error. */
export type WalletResponse = { signed_in: false } | { signed_in: true; wallet: Wallet };
