import billingFile from "../../../../../data/marketplace/billing.json" with { type: "json" };

/**
 * Money settings the web app shows (data/marketplace/billing.json, shared with the API). The API
 * decides every charge; these values only explain the rules on screen.
 */
export const BILLING = {
  minStartMinutes: billingFile.sessions.min_start_minutes,
  requestTimeoutMinutes: Math.ceil(billingFile.sessions.request_timeout_s / 60),
  joinTimeoutSeconds: billingFile.sessions.join_timeout_s,
  heartbeatGraceSeconds: billingFile.sessions.heartbeat_grace_s,
  lowBalanceWarningMinutes: billingFile.sessions.low_balance_warning_minutes,
  realCreditExpiryDays: billingFile.real_credit_expiry_days,
  promoExpiryDays: billingFile.recharge_bonus_tiers.promo_expiry_days,
  recharge: {
    minPaise: billingFile.recharge.min_paise,
    maxPaise: billingFile.recharge.max_paise,
  },
} as const;

/** Balance needed to start a paid chat at this price (the API checks the same rule). */
export function minStartPaise(pricePerMinPaise: number): number {
  return pricePerMinPaise * BILLING.minStartMinutes;
}
