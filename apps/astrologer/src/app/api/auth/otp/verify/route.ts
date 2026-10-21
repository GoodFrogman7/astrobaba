import { NextResponse, type NextRequest } from "next/server";
import { decideAccess } from "@/lib/access";
import { api, API_URL, ApiError } from "@/lib/api";
import { isHttps, SESSION_COOKIE, sessionCookieFlags } from "@/lib/cookies";
import { deviceId } from "@/lib/device";
import type { Me } from "@/lib/types";

/**
 * Verify the code, then check for an astrologer record BEFORE setting any cookie. A sign-in by
 * someone who never applied is revoked straight away, so no console session exists for them.
 * Applicants who are not live yet do get a session: the console shows their status.
 */
export async function POST(req: NextRequest) {
  let challenge_id = "";
  let code = "";
  try {
    const b = (await req.json()) as { challenge_id?: unknown; code?: unknown };
    challenge_id = String(b.challenge_id ?? "");
    code = String(b.code ?? "");
  } catch {
    return NextResponse.json({ code: "invalid_body" }, { status: 400 });
  }
  const device = await deviceId();
  try {
    const session = await api.post<{ token: string; expires_at: string }>(
      "/v1/auth/otp/verify",
      { challenge_id, code, device_id: device.id },
      "",
    );
    const me = await fetch(`${API_URL}/v1/me`, {
      headers: { authorization: `Bearer ${session.token}` },
      cache: "no-store",
    }).then((r) => (r.ok ? (r.json() as Promise<Me>) : null));
    const access = decideAccess(me);
    if (access.kind === "anon" || access.kind === "not_astrologer") {
      await api.post("/v1/auth/logout", undefined, session.token).catch(() => undefined);
      return NextResponse.json({ code: "not_astrologer" }, { status: 403 });
    }
    const res = NextResponse.json({ ok: true, live: access.kind === "live" });
    res.cookies.set(
      SESSION_COOKIE,
      session.token,
      sessionCookieFlags(
        isHttps(req.url, req.headers.get("x-forwarded-proto")),
        session.expires_at,
      ),
    );
    return res;
  } catch (e) {
    const status = e instanceof ApiError ? e.status : 500;
    return NextResponse.json({ code: e instanceof ApiError ? e.code : "unexpected" }, { status });
  }
}
