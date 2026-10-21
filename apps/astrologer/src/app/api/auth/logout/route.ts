import { NextResponse, type NextRequest } from "next/server";
import { api, token } from "@/lib/api";
import { SESSION_COOKIE } from "@/lib/cookies";

export async function POST(req: NextRequest) {
  const t = await token();
  if (t) await api.post("/v1/auth/logout", undefined, t).catch(() => undefined);
  const res = NextResponse.redirect(new URL("/login", req.url), 303);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
