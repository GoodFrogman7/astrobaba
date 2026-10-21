import { NextResponse, type NextRequest } from "next/server";
import { clientIp } from "@/lib/billing/forward";
import {
  buildEnvelopes,
  clearAid,
  existingAid,
  isBot,
  newAnonymousId,
  optedOut,
  postEvents,
  sessionTokenOf,
  setAid,
} from "@/lib/analytics/server";

/** Beacon bodies are small: 20 events of closed-schema fields. */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * First-party analytics collector (docs/api/growth.md §1.1). Answers 204 for opt-outs
 * (GPC/DNT/aid_off, and clears `aid`), bots and batches with nothing valid in them; otherwise
 * creates `aid` if needed, forwards the envelopes to the API and answers 202. Bodies, user
 * agents and IPs are never logged; the user agent is never forwarded.
 */
export async function POST(req: NextRequest) {
  if (optedOut(req)) {
    const res = new NextResponse(null, { status: 204 });
    clearAid(res, req);
    return res;
  }
  if (isBot(req.headers.get("user-agent"))) return new NextResponse(null, { status: 204 });
  // Only our own pages send events; another site cannot post into a visitor's analytics.
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return new NextResponse(null, { status: 204 });

  let body: unknown;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES)
      return NextResponse.json({ code: "too_large" }, { status: 413 });
    body = JSON.parse(text) as unknown;
  } catch {
    return NextResponse.json({ code: "invalid_body" }, { status: 400 });
  }

  const known = existingAid(req);
  const aid = known ?? newAnonymousId();
  const events = buildEnvelopes(body, aid);
  if (events === null) return NextResponse.json({ code: "invalid_body" }, { status: 400 });
  if (events.length === 0) return new NextResponse(null, { status: 204 });

  await postEvents(events, { token: sessionTokenOf(req), ip: clientIp(req.headers) });
  const res = new NextResponse(null, { status: 202 });
  if (!known) setAid(res, req, aid);
  return res;
}
