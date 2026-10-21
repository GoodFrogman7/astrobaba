import { NextResponse, type NextRequest } from "next/server";
import { forward, ID, invalidBody, notFound, readJson } from "@/lib/billing/forward";
import { validateQuestion } from "@/lib/revenue/ai";
import { aiDisabled, missingIdempotencyKey } from "@/lib/revenue/route";

/**
 * Ask a paid question (charged when queued, refunded if it is blocked or fails). The text goes
 * in the body only and is never logged.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const off = aiDisabled();
  if (off) return off;
  const { id } = await params;
  if (!ID.test(id)) return notFound();
  const body = await readJson(req);
  if (!body) return invalidBody();
  const missing = missingIdempotencyKey(req);
  if (missing) return missing;
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const error = validateQuestion(text);
  if (error)
    return NextResponse.json(
      { code: error === "empty" ? "question_empty" : "question_too_long" },
      { status: 422 },
    );
  return forward(req, {
    method: "POST",
    path: `/v1/ai/conversations/${id}/questions`,
    body: { text },
  });
}
