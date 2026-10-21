import { API_URL, token } from "@/lib/api";
import { sessionRoute } from "@/lib/routes";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return sessionRoute(id, { token: await token(), apiUrl: API_URL });
}
