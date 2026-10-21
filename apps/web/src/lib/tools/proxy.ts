import "server-only";

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { api, UpstreamError } from "@/lib/upstream";
import { DEVICE_COOKIE, deviceCookieFlags, isHttps, newDeviceId, SESSION_COOKIE } from "./cookies";

/** Shared helpers for the auth/kundli route handlers that proxy to the core API. */
export function errorResponse(e: unknown) {
  if (e instanceof UpstreamError) {
    return NextResponse.json({ code: e.code }, { status: e.status === 503 ? 503 : e.status });
  }
  return NextResponse.json({ code: "unexpected_error" }, { status: 500 });
}

export async function deviceId(): Promise<{ id: string; isNew: boolean }> {
  const existing = (await cookies()).get(DEVICE_COOKIE)?.value;
  if (existing && /^[a-f0-9]{32}$/.test(existing)) return { id: existing, isNew: false };
  return { id: newDeviceId(), isNew: true };
}

export function setDevice(res: NextResponse, req: NextRequest, id: string) {
  res.cookies.set(
    DEVICE_COOKIE,
    id,
    deviceCookieFlags(isHttps(req.url, req.headers.get("x-forwarded-proto"))),
  );
}

export async function sessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

export { api };
