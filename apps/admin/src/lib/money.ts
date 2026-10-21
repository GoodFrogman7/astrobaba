import type { Tier } from "./types";

/**
 * Rupees typed by an admin ("25", "25.5", "25.50") → integer paise, without floating point.
 * Returns null for anything that is not a plain non-negative amount with at most 2 decimals.
 */
export function rupeesToPaise(input: string): number | null {
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? "").padEnd(2, "0"));
  return whole * 100 + frac;
}

export function formatRupees(paise: number): string {
  const rupees = Math.floor(paise / 100);
  const rest = paise % 100;
  return `₹${rupees.toLocaleString("en-IN")}${rest ? `.${String(rest).padStart(2, "0")}` : ""}`;
}

export type PriceCheck = { ok: true; paise: number } | { ok: false; error: string };

/** Validate a ₹/min price against the tier's bounds from the taxonomy. */
export function checkPrice(input: string, tier: Tier | undefined): PriceCheck {
  if (!tier) return { ok: false, error: "Choose a tier." };
  const paise = rupeesToPaise(input);
  if (paise === null) return { ok: false, error: "Enter a price in rupees, e.g. 25 or 25.50." };
  if (paise < tier.min_price_per_min_paise || paise > tier.max_price_per_min_paise) {
    return {
      ok: false,
      error: `${tier.en} prices must be ${formatRupees(tier.min_price_per_min_paise)}–${formatRupees(
        tier.max_price_per_min_paise,
      )} per minute.`,
    };
  }
  return { ok: true, paise };
}
