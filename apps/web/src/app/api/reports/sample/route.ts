import { REPORT_SKUS, type ReportSku } from "@astro/shared";
import { NextResponse, type NextRequest } from "next/server";
import { API_URL } from "@/lib/upstream";
import { apiReportPath, streamPdf } from "@/lib/revenue/route";

/**
 * The free sample report (fictional birth data), as a PDF download. The API answers with a link
 * (docs/api/revenue.md §2.5); we fetch it on the server so the API origin can stay private.
 */
export async function GET(req: NextRequest) {
  const sku = req.nextUrl.searchParams.get("sku") ?? "";
  const language = req.nextUrl.searchParams.get("language") ?? "";
  if (!REPORT_SKUS.includes(sku as ReportSku) || (language !== "en" && language !== "hi"))
    return NextResponse.json({ code: "invalid_query" }, { status: 400 });
  let link: string | null = null;
  try {
    const res = await fetch(
      `${API_URL}/v1/reports/sample?${new URLSearchParams({ sku, language })}`,
      { cache: "no-store", signal: AbortSignal.timeout(10000) },
    );
    if (res.ok) {
      const body = (await res.json()) as { download_url?: unknown };
      if (typeof body.download_url === "string") link = apiReportPath(body.download_url);
    } else if (res.status === 404) {
      return NextResponse.json({ code: "not_found" }, { status: 404 });
    }
  } catch {
    /* handled below */
  }
  if (!link) return NextResponse.json({ code: "sample_unavailable" }, { status: 503 });
  return streamPdf(
    link,
    {},
    { cache: "public, max-age=3600", filename: `sample-${sku}-${language}.pdf` },
  );
}
