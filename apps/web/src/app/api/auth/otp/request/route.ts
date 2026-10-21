import { NextResponse, type NextRequest } from "next/server";
import { deviceId, errorResponse, setDevice } from "@/lib/tools/proxy";
import { api } from "@/lib/upstream";

/** Ask the API to text a one-time code. The phone number is passed through, never logged. */
export async function POST(req: NextRequest) {
  let phone = "";
  try {
    phone = String(((await req.json()) as { phone?: unknown }).phone ?? "").trim();
  } catch {
    return NextResponse.json({ code: "invalid_body" }, { status: 400 });
  }
  if (!/^[+0-9 -]{10,16}$/.test(phone))
    return NextResponse.json({ code: "unsupported_phone" }, { status: 422 });
  const device = await deviceId();
  try {
    const data = await api.post<{ challenge_id: string; expires_in: number; resend_after: number }>(
      "/v1/auth/otp/request",
      { phone, device_id: device.id },
    );
    const res = NextResponse.json(data, { status: 202 });
    if (device.isNew) setDevice(res, req, device.id);
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}
