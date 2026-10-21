import { NextResponse, type NextRequest } from "next/server";
import { sendOtpVerified } from "@/lib/analytics/server";
import { isHttps, SESSION_COOKIE, sessionCookieFlags } from "@/lib/tools/cookies";
import { deviceId, errorResponse } from "@/lib/tools/proxy";
import { api } from "@/lib/upstream";

/**
 * Verify the code; the session token goes into an httpOnly cookie and never reaches page JS.
 * On success, otp_verified links the visitor's anonymous analytics id to the account
 * (docs/api/growth.md §1.1), server-side and without waiting for it.
 */
export async function POST(req: NextRequest) {
  let body: { challenge_id?: unknown; code?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ code: "invalid_body" }, { status: 400 });
  }
  const challenge = String(body.challenge_id ?? "");
  const code = String(body.code ?? "");
  if (!/^\d{6}$/.test(code) || !challenge)
    return NextResponse.json({ code: "invalid_code" }, { status: 401 });
  const device = await deviceId();
  try {
    const data = await api.post<{
      token: string;
      expires_at: string;
      user: { id: string; is_new: boolean };
    }>("/v1/auth/otp/verify", { challenge_id: challenge, code, device_id: device.id });
    const res = NextResponse.json({ user: data.user });
    res.cookies.set(
      SESSION_COOKIE,
      data.token,
      sessionCookieFlags(isHttps(req.url, req.headers.get("x-forwarded-proto")), data.expires_at),
    );
    void sendOtpVerified(req, data.token, data.user.is_new === true);
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}
