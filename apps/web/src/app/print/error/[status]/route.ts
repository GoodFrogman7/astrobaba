import enReport from "../../../../../messages/en/report.json" with { type: "json" };
import hiReport from "../../../../../messages/hi/report.json" with { type: "json" };

/**
 * Plain error page for the print route with the real HTTP status (403 bad or expired signature,
 * 410 expired, 502 report data unavailable). Bilingual because the report's language is unknown.
 */
const STATUSES = ["403", "404", "410", "502"] as const;
type Status = (typeof STATUSES)[number];

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ status: string }> }) {
  const raw = (await params).status;
  const status: Status = (STATUSES as readonly string[]).includes(raw) ? (raw as Status) : "404";
  const en = enReport.printReport.errors[status];
  const hi = hiReport.printReport.errors[status];
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow"><title>${status}</title></head><body data-print-error="${status}" style="font-family:system-ui,'Noto Sans Devanagari',sans-serif;padding:2rem"><p>${en}</p><p lang="hi">${hi}</p></body></html>`;
  return new Response(html, {
    status: Number(status),
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}
