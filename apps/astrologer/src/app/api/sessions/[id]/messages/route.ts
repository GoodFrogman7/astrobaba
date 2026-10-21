import type { NextRequest } from "next/server";
import { API_URL, token } from "@/lib/api";
import { messagesRoute } from "@/lib/routes";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return messagesRoute(id, req.nextUrl.searchParams, { token: await token(), apiUrl: API_URL });
}
