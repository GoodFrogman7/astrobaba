import { NextResponse, type NextRequest } from "next/server";
import { forward, ID, notFound } from "@/lib/billing/forward";

/** The fields of `CallToken` (packages/shared/src/chat.ts); anything else is not passed on. */
const FIELDS = ["url", "token", "room", "identity", "expires_in"] as const;

/**
 * A LiveKit join token for a call (docs/api/portal.md §1): POST /v1/sessions/{id}/call-token.
 * Only the room token reaches the browser (that is its purpose: join, microphone only, 10 min);
 * the session cookie's Bearer token stays server-side as for every forwarded call. Never cached.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!ID.test(id)) return notFound();
  const res = await forward(req, { method: "POST", path: `/v1/sessions/${id}/call-token` });
  res.headers.set("cache-control", "no-store");
  if (!res.ok) return res;
  const body = (await res.json()) as Record<string, unknown>;
  const picked = Object.fromEntries(FIELDS.filter((k) => k in body).map((k) => [k, body[k]]));
  // Keep the status and any Set-Cookie (new device id); the body changes.
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return NextResponse.json(picked, { status: res.status, headers });
}
