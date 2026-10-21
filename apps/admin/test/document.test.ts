import { describe, expect, it, vi } from "vitest";
import { serveDocument } from "../src/lib/document";
import type { Me } from "../src/lib/types";

const admin: Me = { id: "a", phone: "x", roles: ["admin"] };
const pdf = new TextEncoder().encode("%PDF-1.4 test");

function upstream(type = "application/pdf", status = 200) {
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(pdf);
        c.close();
      },
    }),
    { status, headers: { "content-type": type } },
  );
}

describe("document route", () => {
  it("streams the file inline with no-store for admins", async () => {
    const res = await serveDocument("doc_1", {
      fetchMe: async () => admin,
      fetchContent: async () => upstream(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.body).toBeInstanceOf(ReadableStream);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(pdf);
  });

  it("refuses non-admins without fetching the file", async () => {
    const fetchContent = vi.fn(async () => upstream());
    for (const me of [null, { ...admin, roles: [] }]) {
      const res = await serveDocument("doc_1", { fetchMe: async () => me, fetchContent });
      expect(res.status).toBe(403);
    }
    expect(fetchContent).not.toHaveBeenCalled();
  });

  it("serves unexpected types as downloads, never inline", async () => {
    const res = await serveDocument("doc_1", {
      fetchMe: async () => admin,
      fetchContent: async () => upstream("text/html"),
    });
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
  });

  it("rejects odd ids and passes through 404s", async () => {
    const fetchContent = vi.fn(async () => upstream());
    expect(
      (await serveDocument("../etc/passwd", { fetchMe: async () => admin, fetchContent })).status,
    ).toBe(404);
    expect(fetchContent).not.toHaveBeenCalled();
    const missing = await serveDocument("doc_2", {
      fetchMe: async () => admin,
      fetchContent: async () => new Response("no", { status: 404 }),
    });
    expect(missing.status).toBe(404);
  });
});
