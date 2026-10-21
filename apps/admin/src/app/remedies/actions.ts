"use server";

import { adminAction, field } from "@/lib/actions-common";
import { api } from "@/lib/api";
import { ID } from "@/lib/money-admin";
import { LEAD_STATUS_LABEL, leadErrorText, parseLeadUpdate, type AdminLead } from "@/lib/remedies";
import type { ActionResult } from "@/lib/result";

/**
 * Lead status changes (docs/api/revenue.md §4). The API audits each change under the admin's
 * account (ids and statuses only). Setting the same status again just updates the note, so a
 * retry is harmless and no Idempotency-Key is needed.
 */
export async function updateLead(
  id: string,
  _: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  if (!ID.test(id)) return { ok: false, error: "Unknown lead." };
  const parsed = parseLeadUpdate({ status: field(form, "status"), note: field(form, "note") });
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return adminAction(
    ["/remedies"],
    () => api.post<AdminLead>(`/v1/admin/remedies/leads/${encodeURIComponent(id)}`, parsed.value),
    (lead) => `Marked ${LEAD_STATUS_LABEL[lead.status].toLowerCase()}.`,
    leadErrorText,
  );
}
