import "server-only";

import { revalidatePath } from "next/cache";
import { decideAccess } from "./access";
import { ApiError, fetchMe } from "./api";
import type { ActionResult } from "./result";

/** Run a mutation only for admins; map API errors to a message the form can show. */
export async function adminAction(
  paths: string[],
  run: () => Promise<unknown>,
  message?: string,
): Promise<ActionResult> {
  if (decideAccess(await fetchMe()).kind !== "admin") {
    return { ok: false, error: "Not authorised." };
  }
  try {
    await run();
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, error: e.message || e.code, errors: e.errors };
    return { ok: false, error: "Unexpected error." };
  }
  for (const p of paths) revalidatePath(p);
  return { ok: true, message };
}

export function field(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
}
