"use server";

import { adminAction, field } from "@/lib/actions-common";
import { api } from "@/lib/api";
import type { ActionResult } from "@/lib/result";

const enc = encodeURIComponent;

export async function hideReview(
  id: string,
  _: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const reason = field(form, "reason");
  if (reason.length < 3) return { ok: false, error: "A reason is required." };
  return adminAction(
    ["/reviews", "/"],
    () => api.post(`/v1/admin/reviews/${enc(id)}/hide`, { reason }),
    "Hidden.",
  );
}

export async function unhideReview(id: string): Promise<ActionResult> {
  return adminAction(
    ["/reviews", "/"],
    () => api.post(`/v1/admin/reviews/${enc(id)}/unhide`, {}),
    "Published again.",
  );
}
