import { type NextRequest } from "next/server";
import { forward } from "@/lib/billing/forward";

/** Packs, bounds, bonus switch and payment provider for the recharge form. */
export async function GET(req: NextRequest) {
  return forward(req, { method: "GET", path: "/v1/wallet/recharge-options" });
}
