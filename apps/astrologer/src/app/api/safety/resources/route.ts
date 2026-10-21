import { API_URL, token } from "@/lib/api";
import { safetyResourcesRoute } from "@/lib/portal-routes";

export const dynamic = "force-dynamic";

/** Crisis helplines, fetched by a session room when the page could not load them up front. */
export async function GET() {
  return safetyResourcesRoute({ token: await token(), apiUrl: API_URL });
}
