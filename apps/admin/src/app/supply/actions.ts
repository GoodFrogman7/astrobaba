"use server";

import type { CreatedInvite } from "@astro/shared";
import { revalidatePath } from "next/cache";
import { decideAccess } from "@/lib/access";
import { adminAction, field } from "@/lib/actions-common";
import { ApiError, api, fetchMe } from "@/lib/api";
import { inviteErrorText, parseInviteForm } from "@/lib/growth-admin";
import { ID } from "@/lib/money-admin";
import type { ActionResult } from "@/lib/result";

export type CreateInviteResult =
  { ok: true; invite: CreatedInvite } | { ok: false; error: string; retryable?: boolean };

/**
 * Create an astrologer invite (growth.md §2.1). The code comes back only in this response; it
 * goes straight to the admin's browser, is shown once and is never stored or logged here.
 */
export async function createInvite(
  _: CreateInviteResult | null,
  form: FormData,
): Promise<CreateInviteResult> {
  const parsed = parseInviteForm({
    note: field(form, "note"),
    expires_days: field(form, "expires_days"),
  });
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (decideAccess(await fetchMe()).kind !== "admin") {
    return { ok: false, error: "Not authorised." };
  }
  try {
    const invite = await api.post<CreatedInvite>("/v1/admin/astrologer-invites", parsed.value);
    revalidatePath("/supply");
    return { ok: true, invite };
  } catch (e) {
    if (e instanceof ApiError) {
      return { ok: false, error: e.message || e.code, retryable: e.status >= 500 };
    }
    return { ok: false, error: "Unexpected error.", retryable: true };
  }
}

export async function revokeInvite(id: string): Promise<ActionResult> {
  if (!ID.test(id)) return { ok: false, error: "Unknown invite." };
  return adminAction(
    ["/supply"],
    () => api.post(`/v1/admin/astrologer-invites/${encodeURIComponent(id)}/revoke`),
    "Invite revoked. Its code no longer works.",
    inviteErrorText,
  );
}
