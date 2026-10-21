import { API_URL, token } from "@/lib/api";
import { wsBase } from "@/lib/forward";
import { sessionActionRoute } from "@/lib/routes";

export const dynamic = "force-dynamic";

/** accept | decline | end | ws-ticket */
export async function POST(
  _: Request,
  { params }: { params: Promise<{ id: string; action: string }> },
) {
  const { id, action } = await params;
  return sessionActionRoute(id, action, {
    token: await token(),
    apiUrl: API_URL,
    wsBase: wsBase(process.env),
  });
}
