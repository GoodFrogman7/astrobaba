import { NextResponse, type NextRequest } from "next/server";
import { forward, ID, invalidBody, readJson } from "@/lib/billing/forward";
import { aiDisabled } from "@/lib/revenue/route";

/** Start an AI assistant conversation on one saved kundli (flag `ai_assistant`). */
export async function POST(req: NextRequest) {
  const off = aiDisabled();
  if (off) return off;
  const body = await readJson(req);
  if (!body) return invalidBody();
  const kundliId = body.kundli_id;
  if (typeof kundliId !== "string" || !ID.test(kundliId))
    return NextResponse.json({ code: "invalid_kundli_id" }, { status: 422 });
  return forward(req, {
    method: "POST",
    path: "/v1/ai/conversations",
    body: { kundli_id: kundliId },
  });
}
