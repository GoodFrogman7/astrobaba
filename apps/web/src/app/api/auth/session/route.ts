import { NextResponse } from "next/server";
import { errorResponse, sessionToken } from "@/lib/tools/proxy";
import { api } from "@/lib/upstream";

/** Whether the visitor is signed in (used by "Save my kundli" to skip the OTP step). */
export async function GET() {
  const token = await sessionToken();
  if (!token) return NextResponse.json({ signed_in: false });
  try {
    await api.get("/v1/me", token);
    return NextResponse.json({ signed_in: true });
  } catch (e) {
    const res = errorResponse(e);
    return res.status === 401 ? NextResponse.json({ signed_in: false }) : res;
  }
}
