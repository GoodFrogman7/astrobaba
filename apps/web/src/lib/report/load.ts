import "server-only";
import { api, UpstreamError } from "@/lib/upstream";
import { asRenderData, type RenderData } from "./types";

/**
 * Loads a report's RenderData for the print page (docs/api/revenue.md §2.3). The signed URL is
 * the only credential: no session, no cookies. The signature is never logged.
 */
export type ErrorStatus = 403 | 404 | 410 | 502;
export type LoadResult = { ok: true; data: RenderData } | { ok: false; status: ErrorStatus };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIG = /^[A-Za-z0-9._~:-]{1,512}$/;

/**
 * Sample reports for local preview: /print/reports/fixture-kundli-en and friends. Development
 * only; in a production build `process.env.NODE_ENV` is inlined, this branch is dropped and the
 * fixture files never reach the bundle.
 */
async function devFixture(id: string): Promise<unknown | null> {
  if (process.env.NODE_ENV === "production") return null;
  const { loadFixture } = await import("./fixtures");
  return loadFixture(id);
}

function statusFor(err: unknown): ErrorStatus {
  if (err instanceof UpstreamError) {
    if (err.status === 401 || err.status === 403) return 403;
    if (err.status === 404) return 404;
    if (err.status === 410) return 410;
  }
  return 502;
}

export async function loadRenderData(id: string, sig: string | undefined): Promise<LoadResult> {
  if (id.startsWith("fixture-")) {
    const fx = await devFixture(id);
    const data = fx ? asRenderData(fx) : null;
    return data ? { ok: true, data } : { ok: false, status: 404 };
  }
  if (!UUID.test(id)) return { ok: false, status: 404 };
  if (!sig || !SIG.test(sig)) return { ok: false, status: 403 };
  try {
    const raw = await api.get<unknown>(
      `/v1/reports/render/${encodeURIComponent(id)}?sig=${encodeURIComponent(sig)}`,
    );
    const data = asRenderData(raw);
    if (!data || data.report.id !== id) return { ok: false, status: 502 };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, status: statusFor(err) };
  }
}
