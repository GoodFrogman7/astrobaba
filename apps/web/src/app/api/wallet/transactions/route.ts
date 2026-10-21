import { type NextRequest } from "next/server";
import { forward } from "@/lib/billing/forward";

const CURSOR = /^[A-Za-z0-9_=.:-]{1,512}$/;

/** Wallet transactions, newest first, paged by an opaque cursor. */
export async function GET(req: NextRequest) {
  const q = new URLSearchParams();
  const cursor = req.nextUrl.searchParams.get("cursor");
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 20);
  if (cursor && CURSOR.test(cursor)) q.set("cursor", cursor);
  q.set("limit", String(Number.isInteger(limit) ? Math.min(50, Math.max(1, limit)) : 20));
  return forward(req, { method: "GET", path: `/v1/wallet/transactions?${q}` });
}
