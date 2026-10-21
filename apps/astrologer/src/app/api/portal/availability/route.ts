import type { NextRequest } from "next/server";
import { API_URL, token } from "@/lib/api";
import { json } from "@/lib/forward";
import { availabilityRoute } from "@/lib/portal-routes";

export const dynamic = "force-dynamic";

/** Save the weekly schedule (replaces all slots). */
export async function PUT(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ code: "invalid_body" }, 400);
  }
  return availabilityRoute(body, { token: await token(), apiUrl: API_URL });
}
