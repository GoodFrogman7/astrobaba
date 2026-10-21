import { ASTROLOGER_REPORT_REASONS, type AstrologerReportReason } from "@astro/shared";
import type { IntentKeys } from "@/lib/billing/idempotency";
import type { Fetcher } from "./consent";

/** Report an astrologer to moderators (docs/api/trust.md §4). */
export const REPORT_NOTE_MAX = 500;

export interface ReportInput {
  astrologerId: string;
  sessionId?: string | null;
  reason: AstrologerReportReason | "";
  note: string;
}

export type ReportError = "reason" | "note";

export function validateReport(r: ReportInput): ReportError[] {
  const errors: ReportError[] = [];
  if (!ASTROLOGER_REPORT_REASONS.includes(r.reason as AstrologerReportReason))
    errors.push("reason");
  if (Array.from(r.note.trim()).length > REPORT_NOTE_MAX) errors.push("note");
  return errors;
}

/** POST /v1/reports/astrologer body: the note only when there is one. */
export function reportBody(r: ReportInput) {
  const note = r.note.trim();
  return {
    astrologer_id: r.astrologerId,
    reason: r.reason,
    ...(r.sessionId ? { session_id: r.sessionId } : {}),
    ...(note ? { note } : {}),
  };
}

export type ReportOutcome =
  | { kind: "sent" }
  | { kind: "invalid"; errors: ReportError[] }
  | { kind: "signin" }
  | { kind: "duplicate" }
  | { kind: "error"; key: "network" | "generic" };

/**
 * One Idempotency-Key per report (same body): a retry after a network error sends the same
 * report again instead of a second one. One open report per astrologer (409 report_open).
 */
export async function submitReport(
  input: ReportInput,
  keys: IntentKeys,
  fetcher: (
    url: string,
    init: { method: "POST"; body: unknown; idempotencyKey: string },
  ) => ReturnType<Fetcher>,
): Promise<ReportOutcome> {
  const errors = validateReport(input);
  if (errors.length) return { kind: "invalid", errors };
  const body = reportBody(input);
  const r = await fetcher("/api/astrologer-reports", {
    method: "POST",
    body,
    idempotencyKey: keys.for(JSON.stringify(body)),
  });
  if (r.ok) {
    keys.done();
    return { kind: "sent" };
  }
  if (r.status === 0) return { kind: "error", key: "network" };
  keys.done();
  if (r.status === 401) return { kind: "signin" };
  if (r.status === 409 && r.error.code === "report_open") return { kind: "duplicate" };
  return { kind: "error", key: "generic" };
}
