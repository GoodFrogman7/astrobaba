import { NextResponse, type NextRequest } from "next/server";
import { api, ApiError } from "@/lib/api";
import { DEVICE_COOKIE, isHttps } from "@/lib/cookies";
import { deviceId } from "@/lib/device";

export async function POST(req: NextRequest) {
  let phone = "";
  try {
    phone = String(((await req.json()) as { phone?: unknown }).phone ?? "").trim();
  } catch {
    return NextResponse.json({ code: "invalid_body" }, { status: 400 });
  }
  const device = await deviceId();
  try {
    const body = await api.post<{ challenge_id: string; expires_in: number }>(
      "/v1/auth/otp/request",
      { phone, device_id: device.id },
      "",
    );
    const res = NextResponse.json(body, { status: 202 });
    if (device.isNew) {
      res.cookies.set(DEVICE_COOKIE, device.id, {
        httpOnly: true,
        secure: isHttps(req.url, req.headers.get("x-forwarded-proto")),
        sameSite: "strict",
        path: "/",
        maxAge: 365 * 24 * 3600,
      });
    }
    return res;
  } catch (e) {
    const status = e instanceof ApiError ? e.status : 500;
    return NextResponse.json({ code: e instanceof ApiError ? e.code : "unexpected" }, { status });
  }
}
