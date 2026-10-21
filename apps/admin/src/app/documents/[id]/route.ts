import { apiFetch, fetchMe } from "@/lib/api";
import { serveDocument } from "@/lib/document";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return serveDocument(id, {
    fetchMe,
    fetchContent: (docId) => apiFetch(`/v1/admin/documents/${encodeURIComponent(docId)}/content`),
  });
}
