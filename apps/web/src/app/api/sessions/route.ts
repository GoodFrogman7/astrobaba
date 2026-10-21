import { NextResponse, type NextRequest } from "next/server";
import { forward, ID, invalidBody, readJson } from "@/lib/billing/forward";

/** Request a chat with an astrologer (Idempotency-Key passed through). */
export async function POST(req: NextRequest) {
  const body = await readJson(req);
  if (!body) return invalidBody();
  const astrologerId = body.astrologer_id;
  if (typeof astrologerId !== "string" || !ID.test(astrologerId))
    return NextResponse.json({ code: "invalid_astrologer" }, { status: 422 });
  return forward(req, {
    method: "POST",
    path: "/v1/sessions",
    body: { astrologer_id: astrologerId, kind: "chat", free: body.free === true },
  });
}
