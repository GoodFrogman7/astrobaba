import type { DataExport } from "@astro/shared";
import type { Fetcher } from "./consent";
import type { DeletionRequest, Me } from "./types";

/** Your data (docs/api/trust.md §2): export and deletion from /account. */

export const DELETE_CONFIRM = "DELETE";

/** The user types DELETE (exactly, in capitals) to confirm; spaces around it are ignored. */
export function confirmMatches(text: string): boolean {
  return text.trim() === DELETE_CONFIRM;
}

export type ExportOutcome =
  | { kind: "queued"; item: DataExport }
  | { kind: "tooSoon" }
  | { kind: "signin" }
  | { kind: "error"; key: "network" | "generic" };

/** POST /api/me/export → 202 `{id, status: queued}`; one export per 24 hours (429). */
export async function requestExport(fetcher: Fetcher): Promise<ExportOutcome> {
  const r = await fetcher<{ id: string; status: DataExport["status"]; created_at?: string }>(
    "/api/me/export",
    { method: "POST", body: {} },
  );
  if (r.ok)
    return {
      kind: "queued",
      item: {
        id: r.data.id,
        status: r.data.status ?? "queued",
        created_at: r.data.created_at ?? new Date().toISOString(),
        expires_at: null,
        download_url: null,
      },
    };
  if (r.status === 401) return { kind: "signin" };
  if (r.status === 429) return { kind: "tooSoon" };
  return { kind: "error", key: r.status === 0 ? "network" : "generic" };
}

/** GET /api/me/exports: a bare list or `{items}`. */
export async function loadExports(fetcher: Fetcher): Promise<DataExport[] | "signin" | null> {
  const r = await fetcher<DataExport[] | { items?: DataExport[] }>("/api/me/exports");
  if (!r.ok) return r.status === 401 ? "signin" : null;
  const list = Array.isArray(r.data) ? r.data : Array.isArray(r.data.items) ? r.data.items : [];
  return list.filter((e) => e && typeof e.id === "string");
}

/** The file streams through our origin, with a fresh signed link on each click. */
export function exportDownloadHref(e: DataExport): string | null {
  return e.status === "ready" ? `/api/me/exports/${encodeURIComponent(e.id)}/file` : null;
}

/** Re-read the list while an export is being built. */
export function exportsPending(list: DataExport[]): boolean {
  return list.some((e) => e.status === "queued");
}

export type DeletionState = DeletionRequest | "none" | "signin" | "error";

/** GET /api/me/deletion: the open request, or 404 when there is none. */
export async function loadDeletion(fetcher: Fetcher): Promise<DeletionState> {
  const r = await fetcher<DeletionRequest>("/api/me/deletion");
  if (r.ok) return r.data && typeof r.data.id === "string" ? r.data : "none";
  if (r.status === 404) return "none";
  if (r.status === 401) return "signin";
  return "error";
}

export type DeletionOutcome =
  | { kind: "requested"; request: DeletionRequest }
  | { kind: "cancelled" }
  | { kind: "invalid" }
  | { kind: "signin" }
  | { kind: "error"; key: "network" | "generic" };

/** POST /api/me/deletion `{confirm: "DELETE"}`; nothing is sent until the word matches. */
export async function requestDeletion(text: string, fetcher: Fetcher): Promise<DeletionOutcome> {
  if (!confirmMatches(text)) return { kind: "invalid" };
  const r = await fetcher<DeletionRequest>("/api/me/deletion", {
    method: "POST",
    body: { confirm: DELETE_CONFIRM },
  });
  if (r.ok) return { kind: "requested", request: r.data };
  if (r.status === 401) return { kind: "signin" };
  if (r.status === 422) return { kind: "invalid" };
  return { kind: "error", key: r.status === 0 ? "network" : "generic" };
}

/** DELETE /api/me/deletion cancels the open request. */
export async function cancelDeletion(fetcher: Fetcher): Promise<DeletionOutcome> {
  const r = await fetcher<unknown>("/api/me/deletion", { method: "DELETE" });
  if (r.ok || r.status === 404) return { kind: "cancelled" };
  if (r.status === 401) return { kind: "signin" };
  return { kind: "error", key: r.status === 0 ? "network" : "generic" };
}

export async function loadMe(fetcher: Fetcher): Promise<Me | "signin" | null> {
  const r = await fetcher<Me>("/api/me");
  if (r.ok) return r.data;
  return r.status === 401 ? "signin" : null;
}
