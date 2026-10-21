import { NextResponse, type NextRequest } from "next/server";
import { forward, ID, invalidBody, readJson } from "@/lib/billing/forward";
import { REMEDY_NOTE_MAX } from "@/lib/revenue/config";
import { missingIdempotencyKey } from "@/lib/revenue/route";

const unprocessable = (code: string) => NextResponse.json({ code }, { status: 422 });

/**
 * Ask a partner to contact the user about a remedy (docs/api/revenue.md §4). Consent must be
 * explicitly true; the note (optional, ≤500 characters) goes in the body only, never in logs.
 */
export async function POST(req: NextRequest) {
  const body = await readJson(req);
  if (!body) return invalidBody();
  const missing = missingIdempotencyKey(req);
  if (missing) return missing;
  const { remedy_id: remedyId, preferred_date: date, language, note, consent } = body;
  if (consent !== true) return unprocessable("consent_required");
  if (typeof remedyId !== "string" || !ID.test(remedyId)) return unprocessable("invalid_remedy");
  if (language !== "en" && language !== "hi") return unprocessable("invalid_language");
  if (date !== undefined && (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)))
    return unprocessable("invalid_date");
  if (note !== undefined && (typeof note !== "string" || Array.from(note).length > REMEDY_NOTE_MAX))
    return unprocessable("note_too_long");
  return forward(req, {
    method: "POST",
    path: "/v1/remedies/leads",
    body: {
      remedy_id: remedyId,
      language,
      consent: true,
      ...(typeof date === "string" ? { preferred_date: date } : {}),
      ...(typeof note === "string" && note.trim() ? { note: note.trim() } : {}),
    },
  });
}
