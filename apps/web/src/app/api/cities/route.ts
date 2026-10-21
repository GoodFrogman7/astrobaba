import { NextResponse, type NextRequest } from "next/server";
import { astro, UpstreamError } from "@/lib/upstream";

/** Place search for the birth form. Proxies the astro engine; place names are not personal data. */
export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length < 2 || q.length > 60) return NextResponse.json({ results: [], attribution: "" });
  try {
    const data = await astro.get<unknown>(`/v1/cities?q=${encodeURIComponent(q)}&limit=8`);
    return NextResponse.json(data, { headers: { "cache-control": "public, max-age=3600" } });
  } catch (e) {
    const status = e instanceof UpstreamError ? e.status : 503;
    return NextResponse.json(
      { results: [], error: "unavailable" },
      { status: status >= 500 ? 503 : status },
    );
  }
}
