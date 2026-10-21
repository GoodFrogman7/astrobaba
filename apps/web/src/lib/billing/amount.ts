/** Recharge amount helpers. Input is rupees as typed; everything else is integer paise. */

/** "250" or "250.5" or "₹1,000" → paise; null when it is not a plain amount. */
export function parseRupees(input: string): number | null {
  const clean = input.replace(/[₹,\s]/g, "");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(clean)) return null;
  const [whole = "0", frac = ""] = clean.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

/** Paise → the text shown in the amount field ("250", "250.50"). */
export function paiseToInput(paise: number): string {
  return paise % 100 === 0 ? String(paise / 100) : (paise / 100).toFixed(2);
}

export function inBounds(paise: number, b: { min_paise: number; max_paise: number }): boolean {
  return Number.isInteger(paise) && paise >= b.min_paise && paise <= b.max_paise;
}

/**
 * Amount to suggest when the wallet is short: what is missing, rounded up to whole rupees and
 * raised to the minimum recharge. Never more than the maximum.
 */
export function shortfallPaise(
  requiredPaise: number,
  balancePaise: number,
  b: { min_paise: number; max_paise: number },
): number {
  const missing = Math.max(0, requiredPaise - balancePaise);
  const rounded = Math.ceil(missing / 100) * 100;
  return Math.min(b.max_paise, Math.max(b.min_paise, rounded));
}

/** `?amount=` on /wallet (paise). Out-of-range or junk values are ignored, not clamped silently. */
export function prefillFromQuery(
  raw: string | null,
  b: { min_paise: number; max_paise: number },
): number | null {
  if (!raw || !/^\d{1,9}$/.test(raw)) return null;
  const paise = Number(raw);
  return inBounds(paise, b) ? paise : null;
}
