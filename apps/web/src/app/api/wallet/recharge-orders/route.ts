import { NextResponse, type NextRequest } from "next/server";
import { forward, invalidBody, readJson } from "@/lib/billing/forward";

/** Create a recharge order. The browser's Idempotency-Key is passed through unchanged. */
export async function POST(req: NextRequest) {
  const body = await readJson(req);
  if (!body) return invalidBody();
  const amount = body.amount_paise;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0)
    return NextResponse.json({ code: "amount_out_of_range" }, { status: 422 });
  return forward(req, {
    method: "POST",
    path: "/v1/wallet/recharge-orders",
    body: { amount_paise: amount },
  });
}
