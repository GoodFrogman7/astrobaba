import { type NextRequest } from "next/server";
import { forward, ID, notFound } from "@/lib/billing/forward";

/** One of the user's report orders, polled until the payment webhook settles it. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!ID.test(id)) return notFound();
  return forward(req, { method: "GET", path: `/v1/reports/orders/${id}` });
}
