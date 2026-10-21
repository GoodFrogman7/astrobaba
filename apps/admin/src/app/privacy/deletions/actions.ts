"use server";

import { adminAction } from "@/lib/actions-common";
import { api } from "@/lib/api";
import { ID } from "@/lib/money-admin";
import type { ActionResult } from "@/lib/result";
import { deletionErrorText } from "@/lib/trust-admin";

/**
 * Execute an account deletion (docs/api/trust.md §2). The API refuses with
 * `409 balance_outstanding` / `session_open` until the wallet is settled and no session is open;
 * those come back in plain words with what to do. Audited by the API under the admin's account.
 */
export async function executeDeletion(id: string): Promise<ActionResult> {
  if (!ID.test(id)) return { ok: false, error: "Unknown request." };
  return adminAction(
    ["/privacy/deletions"],
    () => api.post(`/v1/admin/deletions/${encodeURIComponent(id)}/execute`),
    "Deleted. The user's personal data is removed; files are cleaned up by a background job.",
    deletionErrorText,
  );
}
