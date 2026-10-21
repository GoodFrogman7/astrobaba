"use server";

import { adminAction, field } from "@/lib/actions-common";
import { api } from "@/lib/api";
import { ID } from "@/lib/money-admin";
import {
  formatPeriod,
  parseGeneratePeriod,
  parseMarkPaid,
  parseVoidNote,
  payoutErrorText,
} from "@/lib/payouts";
import type { ActionResult } from "@/lib/result";

/**
 * Payout actions (docs/api/portal.md §3). Every call is audited by the API under the admin's
 * account. None of these endpoints take an Idempotency-Key: approve and void are state changes,
 * and mark-paid is keyed by the payout itself (ledger transaction `payout:{id}`), so a retry
 * cannot pay twice.
 */

const LIST = "/money/payouts";
const detail = (id: string) => `/money/payouts/${id}`;

function generatedCount(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  for (const k of ["generated", "count", "created"]) {
    if (typeof b[k] === "number") return b[k] as number;
  }
  return Array.isArray(b.items) ? b.items.length : null;
}

export async function generatePayouts(
  _: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const parsed = parseGeneratePeriod(field(form, "period"));
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const period = parsed.value;
  return adminAction(
    [LIST],
    () => api.post<unknown>("/v1/admin/payouts/generate", { period }),
    (body) => {
      const n = generatedCount(body);
      return `Statements for ${formatPeriod(period)} generated${n === null ? "" : ` (${n})`}. Drafts were recalculated from the ledger; approved and paid statements were not touched.`;
    },
    payoutErrorText,
  );
}

export async function approvePayout(id: string): Promise<ActionResult> {
  if (!ID.test(id)) return { ok: false, error: "Unknown statement." };
  return adminAction(
    [LIST, detail(id)],
    () => api.post(`/v1/admin/payouts/${encodeURIComponent(id)}/approve`),
    "Approved. Next: make the bank transfer, then mark it paid with the bank reference.",
    payoutErrorText,
  );
}

export async function markPayoutPaid(
  id: string,
  _: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  if (!ID.test(id)) return { ok: false, error: "Unknown statement." };
  const parsed = parseMarkPaid({
    reference: field(form, "reference"),
    paid_on: field(form, "paid_on"),
  });
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return adminAction(
    [LIST, detail(id)],
    () => api.post(`/v1/admin/payouts/${encodeURIComponent(id)}/mark-paid`, parsed.value),
    `Marked paid (reference ${parsed.value.reference}). The ledger transaction payout:${id} was posted.`,
    payoutErrorText,
  );
}

export async function voidPayout(
  id: string,
  _: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  if (!ID.test(id)) return { ok: false, error: "Unknown statement." };
  const parsed = parseVoidNote(field(form, "note"));
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return adminAction(
    [LIST, detail(id)],
    () => api.post(`/v1/admin/payouts/${encodeURIComponent(id)}/void`, parsed.value),
    "Statement voided. Nothing was paid, and the earnings stay in the astrologer's payable balance.",
    payoutErrorText,
  );
}
