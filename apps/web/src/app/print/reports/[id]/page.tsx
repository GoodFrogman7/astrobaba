import { notFound, redirect } from "next/navigation";
import { ReportDocument } from "@/components/report/ReportDocument";
import { loadRenderData } from "@/lib/report/load";

/**
 * GET /print/reports/{id}?sig=… (docs/api/revenue.md §2.3): the page the worker prints to PDF
 * with headless Chromium. Private (noindex via the print layout), dynamic, no client JS.
 * Unknown reports are a plain 404; a bad or expired signature or an upstream failure redirects
 * to /print/error/{403|410|502}, which answers with that status (a page cannot set it itself).
 */
export const dynamic = "force-dynamic";

export default async function PrintReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const { sig } = await searchParams;
  const result = await loadRenderData(id, typeof sig === "string" ? sig : undefined);
  if (!result.ok) {
    if (result.status === 404) notFound();
    redirect(`/print/error/${result.status}`);
  }
  return <ReportDocument data={result.data} />;
}
