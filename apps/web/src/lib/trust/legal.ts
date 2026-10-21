import "server-only";

import type { SafetyResources } from "@astro/shared";
import policiesFile from "../../../../../data/legal/policies.json" with { type: "json" };
import { API_URL } from "@/lib/upstream";
import { BUNDLED_RESOURCES, normalizeResources } from "./resources";
import type { LegalInfo, Processor } from "./types";

/** Legal and safety pages are static and re-read these at most this often (ISR). */
export const LEGAL_REVALIDATE_S = 600;

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`${API_URL}${path}`, {
    next: { revalidate: LEGAL_REVALIDATE_S },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

/** The API shows the registry's nulls as "to be published"; the page localizes that itself. */
const TO_BE_PUBLISHED = /^to be published$/i;
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() && !TO_BE_PUBLISHED.test(v.trim()) ? v : null;

export function normalizeLegal(raw: unknown): LegalInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.version !== "string" || typeof r.status !== "string") return null;
  const op = (r.operator ?? {}) as Record<string, unknown>;
  const go = (r.grievance_officer ?? {}) as Record<string, unknown>;
  const processors: Processor[] = [];
  for (const p of Array.isArray(r.processors) ? r.processors : []) {
    const x = (p ?? {}) as Record<string, unknown>;
    if (typeof x.id !== "string" || typeof x.purpose !== "string" || typeof x.data !== "string")
      continue;
    processors.push({
      id: x.id,
      purpose: x.purpose,
      data: x.data,
      region: str(x.region),
      founder_to_fill:
        typeof x.founder_to_fill === "string" || typeof x.founder_to_fill === "boolean"
          ? x.founder_to_fill
          : null,
    });
  }
  return {
    version: r.version,
    status: r.status,
    documents: Array.isArray(r.documents) ? r.documents.filter((d) => typeof d === "string") : [],
    operator: { legal_name: str(op.legal_name), address: str(op.address) },
    grievance_officer: { name: str(go.name), email: str(go.email), note: str(go.note) },
    processors,
    retention: (r.retention && typeof r.retention === "object"
      ? r.retention
      : {}) as LegalInfo["retention"],
  };
}

/**
 * GET /v1/legal at build/revalidate time. The API serves data/legal/policies.json; when it
 * cannot be reached (e.g. a build without the API) the same file is read directly, so the page
 * never shows a version or processor list that differs from the registry.
 */
export async function loadLegal(): Promise<LegalInfo> {
  try {
    const fromApi = normalizeLegal(await getJson("/v1/legal"));
    if (fromApi) return fromApi;
  } catch {
    /* fall back to the registry file */
  }
  return normalizeLegal(policiesFile)!;
}

/**
 * GET /v1/safety/resources (data/safety/helplines.json). Same fallback: the verified file
 * itself, never numbers from anywhere else.
 */
export async function loadSafetyResources(): Promise<SafetyResources> {
  try {
    const fromApi = normalizeResources(await getJson("/v1/safety/resources"));
    if (fromApi) return fromApi;
  } catch {
    /* fall back to the verified file */
  }
  return BUNDLED_RESOURCES;
}
