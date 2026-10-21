import { NextResponse, type NextRequest } from "next/server";
import { forward, invalidBody, readJson } from "@/lib/billing/forward";
import { DELETE_CONFIRM } from "@/lib/trust/account";

/** Account deletion request (docs/api/trust.md §2): read, request, cancel. */
export async function GET(req: NextRequest) {
  return forward(req, { method: "GET", path: "/v1/me/deletion" });
}

/** Only the typed confirmation word is accepted and passed on. */
export async function POST(req: NextRequest) {
  const body = await readJson(req);
  if (!body) return invalidBody();
  if (body.confirm !== DELETE_CONFIRM)
    return NextResponse.json({ code: "confirmation_required" }, { status: 422 });
  return forward(req, {
    method: "POST",
    path: "/v1/me/deletion",
    body: { confirm: DELETE_CONFIRM },
  });
}

export async function DELETE(req: NextRequest) {
  return forward(req, { method: "DELETE", path: "/v1/me/deletion" });
}
