import { NextResponse, type NextRequest } from "next/server";
import { forwardJson } from "@/lib/marketplace/proxy";
import { sessionToken } from "@/lib/tools/proxy";

/**
 * The signed-in user's application. Answers 200 with an explicit state for "signed out" and
 * "no application yet" (expected states, not errors), so browsers log no failed requests.
 */
export async function GET() {
  if (!(await sessionToken())) return NextResponse.json({ signed_in: false, application: null });
  const res = await forwardJson("GET", "/v1/astrologer/me");
  if (res.status === 401) return NextResponse.json({ signed_in: false, application: null });
  if (res.status === 404) return NextResponse.json({ signed_in: true, application: null });
  if (!res.ok) return res;
  return NextResponse.json({ signed_in: true, application: await res.json() });
}

export async function PATCH(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ code: "invalid_body" }, { status: 400 });
  }
  return forwardJson("PATCH", "/v1/astrologer/me", body);
}
