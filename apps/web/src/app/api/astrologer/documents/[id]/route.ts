import { NextResponse } from "next/server";
import { forwardJson } from "@/lib/marketplace/proxy";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id))
    return NextResponse.json({ code: "not_found" }, { status: 404 });
  return forwardJson("DELETE", `/v1/astrologer/me/documents/${id}`);
}
