import "server-only";

import { revalidatePath } from "next/cache";
import { decideAccess } from "./access";
import { ApiError, fetchMe } from "./api";
import type { ActionResult } from "./result";

/**
 * Run a mutation only for admins; map API errors to a message the form can show. `explain`
 * may turn a known error code into plain words; `message` may be built from the response.
 */
export async function adminAction<T = unknown>(
  paths: string[],
  run: () => Promise<T>,
  message?: string | ((result: T) => string),
  explain?: (code: string, message: string) => string | undefined,
): Promise<ActionResult> {
  if (decideAccess(await fetchMe()).kind !== "admin") {
    return { ok: false, error: "Not authorised." };
  }
  let result: T;
  try {
    result = await run();
  } catch (e) {
    if (e instanceof ApiError) {
      return {
        ok: false,
        error: explain?.(e.code, e.message) ?? (e.message || e.code),
        errors: e.errors,
        retryable: e.status >= 500,
      };
    }
    return { ok: false, error: "Unexpected error.", retryable: true };
  }
  for (const p of paths) revalidatePath(p);
  return { ok: true, message: typeof message === "function" ? message(result) : message };
}

export function field(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
}
