import type { DataExport } from "@astro/shared";
import { NextResponse, type NextRequest } from "next/server";
import { ID, notFound, relay } from "@/lib/billing/forward";
import { apiReportPath } from "@/lib/revenue/route";
import { sessionToken } from "@/lib/tools/proxy";
import { API_URL } from "@/lib/upstream";

/**
 * Download a ready export. Each click reads the user's exports (owner only) for a fresh
 * 10-minute signed link and streams the JSON from our origin, so the API origin stays private
 * and the link on the page never expires. Never cached, never logged.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!ID.test(id)) return notFound();
  const token = await sessionToken();
  if (!token) return NextResponse.json({ code: "not_signed_in" }, { status: 401 });
  const auth = { authorization: `Bearer ${token}` };
  let item: DataExport | undefined;
  try {
    const res = await fetch(`${API_URL}/v1/me/exports`, {
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
      headers: auth,
    });
    if (!res.ok) return relay(res);
    const body = (await res.json()) as DataExport[] | { items?: DataExport[] };
    const list = Array.isArray(body) ? body : (body.items ?? []);
    item = list.find((e) => e.id === id);
  } catch {
    return NextResponse.json({ code: "upstream_unavailable" }, { status: 503 });
  }
  if (!item) return notFound();
  const path =
    item.status === "ready" && item.download_url
      ? apiReportPath(item.download_url, "/v1/me/exports/")
      : null;
  if (!path) return NextResponse.json({ code: "export_not_ready" }, { status: 409 });
  let upstream: Response;
  try {
    upstream = await fetch(API_URL + path, {
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
      headers: auth,
    });
  } catch {
    return NextResponse.json({ code: "upstream_unavailable" }, { status: 503 });
  }
  if (!upstream.ok || !upstream.body) return relay(upstream);
  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="my-data-${id}.json"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
