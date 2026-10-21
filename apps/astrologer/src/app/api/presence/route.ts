import type { NextRequest } from "next/server";
import { API_URL, token } from "@/lib/api";
import { json } from "@/lib/forward";
import { presenceRoute } from "@/lib/routes";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ code: "invalid_body" }, 400);
  }
  return presenceRoute(body, { token: await token(), apiUrl: API_URL });
}
