"use server";

import { decideAccess } from "@/lib/access";
import { adminAction, field } from "@/lib/actions-common";
import { api, ApiError, fetchMe } from "@/lib/api";
import { ID } from "@/lib/money-admin";
import type { ActionResult } from "@/lib/result";
import {
  moderationDoneText,
  moderationErrorText,
  parseModerationAction,
  readFlaggedMessage,
  type FlaggedMessage,
} from "@/lib/trust-admin";

/**
 * Moderation queue actions (docs/api/trust.md §4). The API audits each one under the admin's
 * account; `suspend` uses the normal astrologer suspension, `warn` records a strike.
 */

const enc = encodeURIComponent;

export async function actOnModeration(
  id: string,
  _: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  if (!ID.test(id)) return { ok: false, error: "Unknown item." };
  const parsed = parseModerationAction({
    action: field(form, "action"),
    note: field(form, "note"),
  });
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return adminAction(
    ["/moderation", "/astrologers"],
    () => api.post(`/v1/admin/moderation/${enc(id)}`, parsed.value),
    moderationDoneText(parsed.value.action),
    moderationErrorText,
  );
}

export type RevealResult = { ok: true; message: FlaggedMessage } | { ok: false; error: string };

/**
 * Reveal the one flagged message of a `safety` item. The API decrypts it and writes an audit
 * entry with the admin's id; nothing is cached or revalidated here, and the text only lives in
 * the admin's open page until they hide it or leave.
 */
export async function revealFlaggedMessage(id: string): Promise<RevealResult> {
  if (decideAccess(await fetchMe()).kind !== "admin") {
    return { ok: false, error: "Not authorised." };
  }
  if (!ID.test(id)) return { ok: false, error: "Unknown item." };
  try {
    const body = await api.get<unknown>(`/v1/admin/moderation/${enc(id)}/message`);
    const message = readFlaggedMessage(body);
    if (!message) return { ok: false, error: "The API returned no message text." };
    return { ok: true, message };
  } catch (e) {
    if (e instanceof ApiError) {
      return { ok: false, error: moderationErrorText(e.code) ?? (e.message || e.code) };
    }
    return { ok: false, error: "Unexpected error." };
  }
}
