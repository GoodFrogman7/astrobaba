import { flagEnabled } from "@astro/shared";
import billingFile from "../../../../../data/marketplace/billing.json" with { type: "json" };

/**
 * What the refund and credit pages say is derived from the money settings the API charges
 * from (data/marketplace/billing.json), read at build time, so the pages cannot promise more
 * (or less) than the code does. A rule switched off in the file disappears from the page.
 */
type BillingFile = typeof billingFile;

export const KNOWN_REFUND_RULES = [
  "failed_connect",
  "astrologer_drop",
  "low_rating",
  "service_unavailable",
] as const;
export type RefundRuleId = (typeof KNOWN_REFUND_RULES)[number];

export interface RefundRuleView {
  id: string;
  /** Numbers the sentence needs (all from the file). */
  params: Record<string, number>;
}

export function refundRules(file: BillingFile = billingFile): RefundRuleView[] {
  const rules = file.refund_rules as unknown as Record<string, unknown>;
  const out: RefundRuleView[] = [];
  for (const [id, raw] of Object.entries(rules)) {
    if (!raw || typeof raw !== "object") continue; // "decided", notes
    const r = raw as Record<string, unknown>;
    if (r.enabled !== true) continue;
    const params: Record<string, number> = {};
    if (id === "failed_connect") params.seconds = file.sessions.join_timeout_s;
    if (id === "astrologer_drop") params.seconds = file.sessions.heartbeat_grace_s;
    if (id === "low_rating") {
      params.percent = Number(r.refund_bps) / 100;
      params.capPaise = Number(r.cap_paise);
      params.hours = Number(r.window_hours);
      params.maxRating = Number(r.max_rating);
      params.perMonth = Number(r.max_per_user_per_30_days);
    }
    out.push({ id, params });
  }
  return out;
}

export interface CreditPolicy {
  promoFirst: boolean;
  promoExpiryDays: number;
  realExpiryDays: number;
  minRechargePaise: number;
  maxRechargePaise: number;
  bonus: { enabled: boolean; tiers: { minPaise: number; percent: number }[] };
  freeSession: { enabled: boolean; minutes: number };
}

export function creditPolicy(
  file: BillingFile = billingFile,
  env: Record<string, string | undefined> = process.env,
): CreditPolicy {
  return {
    promoFirst: file.spend_order.value[0] === "promo",
    promoExpiryDays: file.recharge_bonus_tiers.promo_expiry_days,
    realExpiryDays: file.real_credit_expiry_days,
    minRechargePaise: file.recharge.min_paise,
    maxRechargePaise: file.recharge.max_paise,
    bonus: {
      enabled: flagEnabled("recharge_bonus_tiers", env),
      tiers: file.recharge_bonus_tiers.tiers.map((t) => ({
        minPaise: t.min_paise,
        percent: t.bonus_bps / 100,
      })),
    },
    freeSession: {
      enabled: flagEnabled("first_free_session", env),
      minutes: file.free_session.minutes,
    },
  };
}
