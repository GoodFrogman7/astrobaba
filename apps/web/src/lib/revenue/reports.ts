import type { Report } from "./types";

/** A report still being made: the list keeps polling while any report is in this state. */
export function inProgress(r: Pick<Report, "status">): boolean {
  return r.status === "queued" || r.status === "rendering";
}

export function needsPolling(items: Pick<Report, "status">[]): boolean {
  return items.some(inProgress);
}

/** 3 s, growing by 1 s per poll, capped at 15 s. */
export function reportPollDelay(attempt: number): number {
  return Math.min(15_000, 3000 + attempt * 1000);
}

/** Polling stops after this long; the page then offers "Check again" (rendering takes minutes). */
export const REPORT_POLL_MAX_MS = 15 * 60_000;

/** Download link for a ready report: our route handler fetches a fresh signed link each time. */
export function downloadHref(r: Pick<Report, "id" | "status" | "download_url">): string | null {
  return r.status === "ready" && r.download_url ? `/api/reports/${r.id}/file` : null;
}

export type WatchResult = "settled" | "stalled" | "cancelled" | { error: number };

/**
 * Read the list, hand each answer to `onUpdate`, and keep reading while a report is in progress:
 * "settled" when every report is ready or failed, "stalled" after `maxMs`, `{error}` with the
 * HTTP status (401 = signed out) when a read fails.
 */
export async function watchReports(
  get: () => Promise<{ ok: true; items: Report[] } | { ok: false; status: number }>,
  onUpdate: (items: Report[]) => void,
  {
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    maxMs = REPORT_POLL_MAX_MS,
    cancelled = () => false,
  }: { sleep?: (ms: number) => Promise<void>; maxMs?: number; cancelled?: () => boolean } = {},
): Promise<WatchResult> {
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    const r = await get();
    if (cancelled()) return "cancelled";
    if (!r.ok) return { error: r.status };
    onUpdate(r.items);
    if (!needsPolling(r.items)) return "settled";
    const d = reportPollDelay(attempt);
    if (waited + d > maxMs) return "stalled";
    await sleep(d);
    waited += d;
    if (cancelled()) return "cancelled";
  }
}
