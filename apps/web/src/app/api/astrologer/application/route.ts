import { NextResponse, type NextRequest } from "next/server";
import { validateApplication } from "@/lib/marketplace/application";
import { forwardJson } from "@/lib/marketplace/proxy";

/** Submit an astrologer application for the signed-in user. */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ code: "invalid_body" }, { status: 400 });
  }
  const errors = validateApplication(body);
  if (errors.length)
    return NextResponse.json({ code: "invalid_fields", fields: errors }, { status: 422 });
  return forwardJson("POST", "/v1/astrologer/application", body);
}
