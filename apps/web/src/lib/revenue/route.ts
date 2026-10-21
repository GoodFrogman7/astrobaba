import "server-only";

import { flagEnabled } from "@astro/shared";
import { NextResponse, type NextRequest } from "next/server";
import { relay } from "@/lib/billing/forward";
import { API_URL } from "@/lib/upstream";

/** Route-handler helpers for reports, AI and remedies (docs/api/revenue.md). */

/** Writes that move money or create leads must carry the browser's Idempotency-Key. */
export function missingIdempotencyKey(req: NextRequest): NextResponse | null {
  return req.headers.get("idempotency-key")
    ? null
    : NextResponse.json({ code: "idempotency_key_required" }, { status: 400 });
}

/** The AI assistant routes exist only while the `ai_assistant` flag is on (else plain 404). */
export function aiDisabled(): NextResponse | null {
  return flagEnabled("ai_assistant")
    ? null
    : NextResponse.json({ code: "not_found" }, { status: 404 });
}

/** Public, no-session GET to the API (products, sample). */
export async function publicGet(path: string): Promise<NextResponse> {
  try {
    const res = await fetch(API_URL + path, {
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    return await relay(res);
  } catch {
    return NextResponse.json({ code: "upstream_unavailable" }, { status: 503 });
  }
}

/**
 * Reduce an API download link (absolute or relative) to a path under /v1/reports on our own API
 * origin, so a link can never make the server fetch another host.
 */
export function apiReportPath(downloadUrl: string, prefix = "/v1/reports/"): string | null {
  let u: URL;
  try {
    u = new URL(downloadUrl, API_URL);
  } catch {
    return null;
  }
  if (!u.pathname.startsWith(prefix) || u.pathname.includes("..")) return null;
  return u.pathname + u.search;
}

/**
 * Stream a PDF from the API to the browser with our own headers only: a download, never cached
 * by shared caches, never sniffed.
 */
export async function streamPdf(
  path: string,
  headers: Record<string, string>,
  {
    cache = "private, no-store",
    filename = "report.pdf",
  }: { cache?: string; filename?: string } = {},
): Promise<NextResponse> {
  let upstream: Response;
  try {
    upstream = await fetch(API_URL + path, {
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
      headers,
    });
  } catch {
    return NextResponse.json({ code: "upstream_unavailable" }, { status: 503 });
  }
  if (!upstream.ok || !upstream.body) return relay(upstream);
  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": cache,
      "x-content-type-options": "nosniff",
    },
  });
}
