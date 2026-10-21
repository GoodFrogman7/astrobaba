"use server";

import { adminAction, field } from "@/lib/actions-common";
import { api } from "@/lib/api";
import { parseContentForm } from "@/lib/growth-admin";
import { ID } from "@/lib/money-admin";
import type { ActionResult } from "@/lib/result";

function contentError(code: string): string | undefined {
  return code === "not_found" ? "This item no longer exists. Reload the page." : undefined;
}

/** Create (id null) or update a content calendar item (growth.md §4.1). */
export async function saveContentItem(
  id: string | null,
  _: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  if (id !== null && !ID.test(id)) return { ok: false, error: "Unknown item." };
  const parsed = parseContentForm({
    title: field(form, "title"),
    kind: field(form, "kind"),
    locale: field(form, "locale"),
    status: field(form, "status"),
    due_date: field(form, "due_date"),
    url: field(form, "url"),
    notes: field(form, "notes"),
  });
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const body = parsed.value;
  return adminAction(
    ["/content"],
    () =>
      id === null
        ? api.post("/v1/admin/content-items", body)
        : api.patch(`/v1/admin/content-items/${encodeURIComponent(id)}`, body),
    id === null ? `Added “${body.title}”.` : "Saved.",
    contentError,
  );
}

export async function deleteContentItem(id: string): Promise<ActionResult> {
  if (!ID.test(id)) return { ok: false, error: "Unknown item." };
  return adminAction(
    ["/content"],
    () => api.del(`/v1/admin/content-items/${encodeURIComponent(id)}`),
    "Deleted.",
    contentError,
  );
}
