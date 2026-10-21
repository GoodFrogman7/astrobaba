import { type NextRequest } from "next/server";
import { forward, ID, notFound } from "@/lib/billing/forward";
import { aiDisabled } from "@/lib/revenue/route";

/** A conversation with its questions and answers (polled while an answer is pending). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const off = aiDisabled();
  if (off) return off;
  const { id } = await params;
  if (!ID.test(id)) return notFound();
  return forward(req, { method: "GET", path: `/v1/ai/conversations/${id}` });
}
