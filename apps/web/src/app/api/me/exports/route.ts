import type { NextRequest } from "next/server";
import { forward } from "@/lib/billing/forward";

/** The user's data exports with status; download links are fetched fresh per click. */
export async function GET(req: NextRequest) {
  return forward(req, { method: "GET", path: "/v1/me/exports" });
}
