import type { NextRequest } from "next/server";
import { API_URL, token } from "@/lib/api";
import { json } from "@/lib/forward";
import { reviewReplyRoute } from "@/lib/portal-routes";

export const dynamic = "force-dynamic";

/** Reply to a review (once). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ code: "invalid_body" }, 400);
  }
  return reviewReplyRoute(id, body, { token: await token(), apiUrl: API_URL });
}
