"use server";

import { adminAction, field } from "@/lib/actions-common";
import { api } from "@/lib/api";
import { formatRupees } from "@/lib/money";
import { parseOverride, parseRefund, parseReconDate } from "@/lib/money-admin";
import type { ActionResult } from "@/lib/result";

/**
 * Manual goodwill refund. The Idempotency-Key comes from the form (one per refund the admin
 * means to make, reused on retry), so a double click or a retry after a timeout pays once.
 */
export async function manualRefund(_: ActionResult | null, form: FormData): Promise<ActionResult> {
  const parsed = parseRefund({
    session_id: field(form, "session_id"),
    amount_rupees: field(form, "amount_rupees"),
    note: field(form, "note"),
    idempotency_key: field(form, "idempotency_key"),
  });
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const { key, body } = parsed.value;
  const result = await adminAction(
    ["/money/refunds"],
    () => api.post("/v1/admin/money/refunds", body, undefined, { "Idempotency-Key": key }),
    `Refund of ${formatRupees(body.amount_paise)} recorded for session ${body.session_id}.`,
    (code) =>
      code === "idempotency_conflict"
        ? "This form was already used for a different refund. Check the list below before trying again."
        : undefined,
  );
  return result;
}

export async function overrideFreeSession(
  userId: string,
  _: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const parsed = parseOverride(userId, {
    action: field(form, "action"),
    note: field(form, "note"),
  });
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return adminAction(
    ["/money/free-sessions"],
    () => api.post("/v1/admin/money/free-sessions/override", parsed.value),
    `Override “${parsed.value.action}” saved.`,
  );
}

export async function runReconciliation(
  _: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const parsed = parseReconDate(field(form, "date"));
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return adminAction(
    ["/money/reconciliation"],
    () => api.post("/v1/admin/money/reconciliation/run", { date: parsed.value }),
    `Reconciliation for ${parsed.value} started. Reload to see the result.`,
  );
}
