/**
 * Paid reports in the admin console (docs/api/revenue.md §2.3a): the list shows ids, product,
 * status, attempts and the last error code only, never birth details. A `failed` render can be
 * queued again; in v1 that is always free for the user (`charge_again: false`).
 */

export const REPORT_STATUSES = ["queued", "rendering", "ready", "failed"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export interface AdminReportRow {
  id: string;
  /** The contract says "owner id"; accept either spelling until the API is final. */
  user_id?: string;
  owner_id?: string;
  sku: string;
  language?: string;
  status: ReportStatus;
  attempts: number;
  last_error_code: string | null;
  created_at: string;
  ready_at?: string | null;
  refunded?: boolean;
}

export const REPORT_STATUS_LABEL: Record<ReportStatus, string> = {
  queued: "Queued",
  rendering: "Rendering",
  ready: "Ready",
  failed: "Failed",
};

export const SKU_LABEL: Record<string, string> = {
  kundli_report: "Kundli report",
  matching_report: "Matching report",
};

export function reportStatusFilter(input: string | undefined): ReportStatus | null {
  return (REPORT_STATUSES as readonly string[]).includes(input ?? "")
    ? (input as ReportStatus)
    : null;
}

export function ownerOf(row: AdminReportRow): string {
  return row.owner_id ?? row.user_id ?? "–";
}

export function canRetry(row: AdminReportRow): boolean {
  return row.status === "failed";
}

/** The only option in v1: a retried report is never charged again. */
export const RETRY_BODY = { charge_again: false } as const;

export function reportErrorText(code: string): string | undefined {
  switch (code) {
    case "not_found":
      return "This report no longer exists.";
    case "invalid_transition":
    case "not_failed":
    case "report_not_failed":
      return "Only a failed report can be retried. Reload to see its current status.";
    default:
      return undefined;
  }
}
