import { decideAccess } from "./access";
import type { Me } from "./types";

export interface DocumentDeps {
  fetchMe: () => Promise<Me | null>;
  fetchContent: (id: string) => Promise<Response>;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);

/**
 * Stream a KYC document from the API to an admin. The body is piped through, never buffered or
 * cached; anything but PDF/JPEG/PNG is served as a download so it cannot run in the console.
 */
export async function serveDocument(id: string, deps: DocumentDeps): Promise<Response> {
  const access = decideAccess(await deps.fetchMe());
  if (access.kind !== "admin") return new Response("Not authorised", { status: 403 });
  if (!ID.test(id)) return new Response("Not found", { status: 404 });
  const upstream = await deps.fetchContent(id);
  if (!upstream.ok || !upstream.body) {
    return new Response("Not found", { status: upstream.status === 404 ? 404 : 502 });
  }
  const type = (upstream.headers.get("content-type") ?? "").split(";")[0]!.trim();
  const inline = SAFE_TYPES.has(type);
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": inline ? type : "application/octet-stream",
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="document-${id}"`,
      "cache-control": "no-store, max-age=0",
      pragma: "no-cache",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    },
  });
}
