import type { NextRequest } from "next/server";
import { API_URL, token } from "@/lib/api";
import { json } from "@/lib/forward";
import { consultRoute } from "@/lib/portal-routes";

export const dynamic = "force-dynamic";

/** Turn chat or calls on or off. */
export async function PATCH(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ code: "invalid_body" }, 400);
  }
  return consultRoute(body, { token: await token(), apiUrl: API_URL });
}
