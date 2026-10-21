import { ASTROLOGER_REPORT_REASONS, type AstrologerReportReason } from "@astro/shared";
import { NextResponse, type NextRequest } from "next/server";
import { forward, ID, invalidBody, readJson } from "@/lib/billing/forward";
import { missingIdempotencyKey } from "@/lib/revenue/route";
import { REPORT_NOTE_MAX } from "@/lib/trust/report";

const unprocessable = (code: string) => NextResponse.json({ code }, { status: 422 });

/**
 * Report an astrologer to moderators (docs/api/trust.md §4). The note (optional, ≤500
 * characters) travels in the body only; the API stores it encrypted. Never logged.
 */
export async function POST(req: NextRequest) {
  const body = await readJson(req);
  if (!body) return invalidBody();
  const missing = missingIdempotencyKey(req);
  if (missing) return missing;
  const { astrologer_id: astrologerId, session_id: sessionId, reason, note } = body;
  if (typeof astrologerId !== "string" || !ID.test(astrologerId))
    return unprocessable("invalid_astrologer");
  if (sessionId !== undefined && (typeof sessionId !== "string" || !ID.test(sessionId)))
    return unprocessable("invalid_session");
  if (!ASTROLOGER_REPORT_REASONS.includes(reason as AstrologerReportReason))
    return unprocessable("invalid_reason");
  if (note !== undefined && (typeof note !== "string" || Array.from(note).length > REPORT_NOTE_MAX))
    return unprocessable("note_too_long");
  return forward(req, {
    method: "POST",
    path: "/v1/reports/astrologer",
    body: {
      astrologer_id: astrologerId,
      reason,
      ...(typeof sessionId === "string" ? { session_id: sessionId } : {}),
      ...(typeof note === "string" && note.trim() ? { note: note.trim() } : {}),
    },
  });
}
