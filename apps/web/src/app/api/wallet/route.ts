import { NextResponse, type NextRequest } from "next/server";
import { forward } from "@/lib/billing/forward";
import { sessionToken } from "@/lib/tools/proxy";

/**
 * The signed-in user's wallet. Signed out is an expected state (the header asks on every page),
 * so it answers 200 `{signed_in: false}` instead of an error the browser would log.
 */
export async function GET(req: NextRequest) {
  if (!(await sessionToken())) return NextResponse.json({ signed_in: false });
  const res = await forward(req, { method: "GET", path: "/v1/wallet" });
  if (res.status === 401) return NextResponse.json({ signed_in: false });
  if (!res.ok) return res;
  const out = NextResponse.json({ signed_in: true, wallet: await res.json() });
  for (const c of res.cookies.getAll()) out.cookies.set(c);
  return out;
}
