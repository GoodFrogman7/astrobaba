import type { NextRequest } from "next/server";
import { forward } from "@/lib/billing/forward";

/** Ask for a copy of everything we hold about the user (one per 24 hours, else 429). */
export async function POST(req: NextRequest) {
  return forward(req, { method: "POST", path: "/v1/me/export" });
}
