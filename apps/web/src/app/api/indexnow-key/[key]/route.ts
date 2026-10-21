import { indexNowKey } from "@/lib/publishing";

// The key comes from the environment at request time.
export const dynamic = "force-dynamic";

/**
 * Serves /{INDEXNOW_KEY}.txt (rewritten here by next.config.ts) so IndexNow can verify that the
 * submitter owns the site (docs/api/growth.md §3). 404 unless INDEXNOW_KEY is set, valid and
 * equal to the requested name.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const expected = indexNowKey();
  if (!expected || key !== expected) return new Response("Not found", { status: 404 });
  return new Response(expected, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
