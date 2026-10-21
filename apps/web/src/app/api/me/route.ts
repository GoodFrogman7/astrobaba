import type { NextRequest } from "next/server";
import { forward } from "@/lib/billing/forward";

/** The signed-in user's profile summary (phone masked by the API). */
export async function GET(req: NextRequest) {
  return forward(req, { method: "GET", path: "/v1/me" });
}
