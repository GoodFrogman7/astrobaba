import { ApiError } from "./api";

/**
 * Load a list for a page without failing the whole page: the error is shown in place and the
 * page's forms keep working.
 */
export async function tryLoad<T>(
  load: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; status: number; error: string }> {
  try {
    return { ok: true, value: await load() };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, status: e.status, error: e.message || e.code };
    throw e;
  }
}
