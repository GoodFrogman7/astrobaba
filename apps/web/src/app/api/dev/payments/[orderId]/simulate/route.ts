import { NextResponse, type NextRequest } from "next/server";
import { forward, ID, invalidBody, notFound, readJson } from "@/lib/billing/forward";

/**
 * Development only: simulate the fake provider's webhook. Always forwarded; the API answers 404
 * in production, so there is no second switch to keep in sync here.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  if (!ID.test(orderId)) return notFound();
  const body = await readJson(req);
  if (!body) return invalidBody();
  const outcome = body.outcome;
  if (outcome !== "captured" && outcome !== "failed")
    return NextResponse.json({ code: "invalid_outcome" }, { status: 422 });
  return forward(req, {
    method: "POST",
    path: `/v1/dev/payments/${orderId}/simulate`,
    body: { outcome },
  });
}
