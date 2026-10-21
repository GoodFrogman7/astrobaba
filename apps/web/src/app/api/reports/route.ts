import { type NextRequest } from "next/server";
import { forward } from "@/lib/billing/forward";

/** The signed-in user's reports (docs/api/revenue.md §2.2). */
export async function GET(req: NextRequest) {
  return forward(req, { method: "GET", path: "/v1/reports" });
}
