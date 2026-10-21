import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "./lib/cookies";

/** Unauthenticated visitors go to /login. Role checks happen server-side on every page. */
export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === "/login" || pathname.startsWith("/api/auth/")) return NextResponse.next();
  if (!req.cookies.get(SESSION_COOKIE)?.value) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: "/((?!_next|icon\\.svg|favicon\\.ico).*)" };
