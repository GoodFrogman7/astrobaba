import { API_URL, token } from "@/lib/api";
import { statementCsvRoute } from "@/lib/portal-routes";

export const dynamic = "force-dynamic";

/** Download a payout statement as CSV (streamed from the API). */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return statementCsvRoute(id, { token: await token(), apiUrl: API_URL });
}
