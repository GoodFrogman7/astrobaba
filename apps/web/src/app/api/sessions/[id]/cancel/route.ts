import { type NextRequest } from "next/server";
import { forward, ID, notFound } from "@/lib/billing/forward";

/** Cancel a request before the chat starts (queued, requested or accepted). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!ID.test(id)) return notFound();
  return forward(req, { method: "POST", path: `/v1/sessions/${id}/cancel` });
}
