import { type NextRequest } from "next/server";
import { forward, ID, invalidBody, notFound, readJson } from "@/lib/billing/forward";

/**
 * Record the Razorpay Checkout result for a report order. Like recharges, this only verifies
 * and records; the order is marked paid by the webhook.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!ID.test(id)) return notFound();
  const body = await readJson(req);
  if (!body) return invalidBody();
  const { provider_payment_id: payment, provider_signature: signature } = body;
  if (typeof payment !== "string" || typeof signature !== "string") return invalidBody();
  return forward(req, {
    method: "POST",
    path: `/v1/reports/orders/${id}/checkout-result`,
    body: { provider_payment_id: payment, provider_signature: signature },
  });
}
