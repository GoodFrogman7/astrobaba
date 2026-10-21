/**
 * `retryable`: the outcome is unknown (API unreachable, timeout, 5xx), so a retry must reuse the
 * same Idempotency-Key. Any other failure is a definite answer.
 */
export type ActionResult =
  | { ok: true; message?: string }
  | { ok: false; error: string; errors?: string[]; retryable?: boolean };

export const IDLE: ActionResult | null = null;
