import { NextResponse, type NextRequest } from "next/server";
import { decideAccess } from "@/lib/access";
import { api, ApiError } from "@/lib/api";
import { isHttps, SESSION_COOKIE, sessionCookieFlags } from "@/lib/cookies";
import { deviceId } from "@/lib/device";
import type { Me } from "@/lib/types";

/**
 * Verify the code, then check the admin role BEFORE setting any cookie. A valid sign-in by a
 * non-admin is revoked straight away, so no admin-console session exists for them.
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
    const me = await fetch(
      `${(process.env.API_URL ?? "http://localhost:8000").replace(/\/$/, "")}/v1/me`,
      { headers: { authorization: `Bearer ${session.token}` }, cache: "no-store" },
    ).then((r) => (r.ok ? (r.json() as Promise<Me>) : null));
    if (decideAccess(me).kind !== "admin") {
      await api.post("/v1/auth/logout", undefined, session.token).catch(() => undefined);
      return NextResponse.json({ code: "not_admin" }, { status: 403 });
    }
    const res = NextResponse.json({ ok: true });
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
