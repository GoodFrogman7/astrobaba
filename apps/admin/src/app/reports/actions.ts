"use server";

import { adminAction } from "@/lib/actions-common";
import { api } from "@/lib/api";
import { ID } from "@/lib/money-admin";
import { RETRY_BODY, reportErrorText } from "@/lib/reports-admin";
import type { ActionResult } from "@/lib/result";

/**
 * Re-queue a failed render (docs/api/revenue.md §2.3a). The API gives each retry a new job key
 * and audits it; the user is never charged again (`charge_again: false` is the only option).
 */
export async function retryReport(id: string): Promise<ActionResult> {
  if (!ID.test(id)) return { ok: false, error: "Unknown report." };
  return adminAction(
    ["/reports"],
    () => api.post(`/v1/admin/reports/${encodeURIComponent(id)}/retry`, RETRY_BODY),
    "Queued again. The worker will render it shortly; the user is not charged again.",
    reportErrorText,
  );
}
