import { NextResponse, type NextRequest } from "next/server";
import { ID, notFound } from "@/lib/billing/forward";
import { sessionToken } from "@/lib/tools/proxy";
import { API_URL } from "@/lib/upstream";
import { apiReportPath, streamPdf } from "@/lib/revenue/route";
import type { Report } from "@/lib/revenue/types";

/**
 * Download a ready report. Each click asks the API for the report (owner only) and a fresh
 * 10-minute signed link, then streams the PDF from our origin, so links on the page never expire
 * and the API origin stays private.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!ID.test(id)) return notFound();
  const token = await sessionToken();
  if (!token) return NextResponse.json({ code: "not_signed_in" }, { status: 401 });
  const auth = { authorization: `Bearer ${token}` };
  let report: Report;
  try {
    const res = await fetch(`${API_URL}/v1/reports/${id}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
      headers: auth,
    });
    if (!res.ok)
      return NextResponse.json({ code: "not_found" }, { status: res.status === 401 ? 401 : 404 });
    report = (await res.json()) as Report;
  } catch {
    return NextResponse.json({ code: "upstream_unavailable" }, { status: 503 });
  }
  const path =
    report.status === "ready" && report.download_url
      ? apiReportPath(report.download_url, `/v1/reports/${id}/file`)
      : null;
  if (!path) return NextResponse.json({ code: "report_not_ready" }, { status: 409 });
  return streamPdf(path, auth, { filename: `report-${id}.pdf` });
}
