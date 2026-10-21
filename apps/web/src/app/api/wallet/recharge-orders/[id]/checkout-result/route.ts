import { NextResponse, type NextRequest } from "next/server";
import { forward, ID, invalidBody, notFound, readJson } from "@/lib/billing/forward";

const TOKEN = /^[A-Za-z0-9_-]{1,128}$/;

/** Razorpay Checkout's result. The API verifies and records it; credit comes from the webhook. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!ID.test(id)) return notFound();
  const body = await readJson(req);
  if (!body) return invalidBody();
  const payment = String(body.provider_payment_id ?? "");
  const signature = String(body.provider_signature ?? "");
  if (!TOKEN.test(payment) || !TOKEN.test(signature))
    return NextResponse.json({ code: "invalid_checkout_result" }, { status: 422 });
  return forward(req, {
    method: "POST",
    path: `/v1/wallet/recharge-orders/${id}/checkout-result`,
    body: { provider_payment_id: payment, provider_signature: signature },
  });
}
