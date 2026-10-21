import { NextResponse, type NextRequest } from "next/server";
import { forward, ID, invalidBody, notFound, readJson } from "@/lib/billing/forward";
import { TAXONOMY } from "@/lib/marketplace/taxonomy";

/** Review a completed session (docs/api/marketplace.md: POST /v1/consult-sessions/{id}/review). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!ID.test(id)) return notFound();
  const body = await readJson(req);
  if (!body) return invalidBody();
  const rating = body.rating;
  const text = String(body.text ?? "").trim();
  if (typeof rating !== "number" || !Number.isInteger(rating) || rating < 1 || rating > 5)
    return NextResponse.json({ code: "invalid_rating" }, { status: 422 });
  if (text.length > TAXONOMY.review.max_text_chars)
    return NextResponse.json({ code: "text_too_long" }, { status: 422 });
  return forward(req, {
    method: "POST",
    path: `/v1/consult-sessions/${id}/review`,
    body: { rating, text },
  });
}
