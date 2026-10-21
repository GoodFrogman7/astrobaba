import { type NextRequest } from "next/server";
import { forward, ID, notFound } from "@/lib/billing/forward";

/** History after a sequence number: the backfill a client loads on (re)connect. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!ID.test(id)) return notFound();
  const after = Number(req.nextUrl.searchParams.get("after_seq") ?? 0);
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 200);
  const q = new URLSearchParams({
    after_seq: String(Number.isInteger(after) && after >= 0 ? after : 0),
    limit: String(Number.isInteger(limit) ? Math.min(200, Math.max(1, limit)) : 200),
  });
  return forward(req, { method: "GET", path: `/v1/sessions/${id}/messages?${q}` });
}
