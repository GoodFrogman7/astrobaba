import { NextResponse, type NextRequest } from "next/server";
import { forwardJson } from "@/lib/marketplace/proxy";

/** Report a review for moderation (signed-in users). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id))
    return NextResponse.json({ code: "not_found" }, { status: 404 });
  let reason = "";
  try {
    reason = String(((await req.json()) as { reason?: unknown }).reason ?? "").trim();
  } catch {
    return NextResponse.json({ code: "invalid_body" }, { status: 400 });
  }
  if (!reason || reason.length > 500)
    return NextResponse.json({ code: "reason_required" }, { status: 422 });
  return forwardJson("POST", `/v1/reviews/${id}/report`, { reason });
}
