import { API_URL, token } from "@/lib/api";
import { incomingRoute } from "@/lib/routes";

export const dynamic = "force-dynamic";

export async function GET() {
  return incomingRoute({ token: await token(), apiUrl: API_URL });
}
