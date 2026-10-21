import { NextResponse, type NextRequest } from "next/server";
import { forward, ID, notFound } from "@/lib/billing/forward";

/**
 * A single-use, 30-second ticket for the chat socket. Fetched again on every (re)connect.
 * Adds `ws_base`, the API's WebSocket origin read at request time (API_WS_URL), so the Docker
 * image needs no rebuild per environment.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!ID.test(id)) return notFound();
  const res = await forward(req, { method: "POST", path: `/v1/sessions/${id}/ws-ticket` });
  const wsBase = process.env.API_WS_URL;
  if (!res.ok || !wsBase) return res;
  const body = (await res.json()) as Record<string, unknown>;
  // Keep the status and any Set-Cookie (new device id); the body length changes.
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return NextResponse.json(
    { ...body, ws_base: wsBase.replace(/\/$/, "") },
    { status: res.status, headers },
  );
}
