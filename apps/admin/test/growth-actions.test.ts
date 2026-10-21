import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same harness as payout-actions.test.ts: Next server modules stubbed, network mocked, so the
// guard → API client → headers chain runs for real against the growth.md contract.
vi.mock("server-only", () => ({}));
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "ap_admin_session" ? { value: "admin-token" } : undefined),
  }),
}));

const { createInvite, revokeInvite } = await import("../src/app/supply/actions");
const { saveContentItem, deleteContentItem } = await import("../src/app/content/actions");

type Call = { path: string; method: string; auth?: string; body: unknown };
let calls: Call[] = [];
let roles = ["admin"];
let respond: (c: Call) => Response = () => Response.json({});

function form(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
const api = () => calls.filter((c) => c.path !== "/v1/me");
const err = (status: number, code: string, message: string) =>
  Response.json({ detail: { code, message } }, { status });

beforeEach(() => {
  calls = [];
  roles = ["admin"];
  revalidatePath.mockClear();
  respond = () => Response.json({});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      const call: Call = {
        path: new URL(url).pathname,
        method: init.method ?? "GET",
        auth: headers.authorization,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      if (call.path === "/v1/me") return Response.json({ id: "a1", phone: "+91•••", roles });
      return respond(call);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("invite create and revoke", () => {
  const created = {
    id: "inv1",
    code: "ABCDEFGH2345",
    url: "https://astro.example/apply?invite=ABCDEFGH2345",
    expires_at: "2026-11-04T06:00:00Z",
  };

  it("creates an invite and returns the one-time code to the form", async () => {
    respond = () => Response.json(created, { status: 201 });
    const r = await createInvite(null, form({ note: " For Pandit ji ", expires_days: "21" }));
    expect(r).toEqual({ ok: true, invite: created });
    expect(api()).toEqual([
      {
        path: "/v1/admin/astrologer-invites",
        method: "POST",
        auth: "Bearer admin-token",
        body: { note: "For Pandit ji", expires_days: 21 },
      },
    ]);
    expect(revalidatePath).toHaveBeenCalledWith("/supply");
  });

  it("sends the default expiry and no note when both are blank", async () => {
    respond = () => Response.json(created, { status: 201 });
    await createInvite(null, form({ note: "", expires_days: "" }));
    expect(api()[0]?.body).toEqual({ expires_days: 14 });
  });

  it("validates before calling the API", async () => {
    expect((await createInvite(null, form({ note: "x".repeat(201), expires_days: "14" }))).ok).toBe(
      false,
    );
    expect((await createInvite(null, form({ note: "", expires_days: "61" }))).ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("refuses non-admins and reports API failures", async () => {
    roles = ["client"];
    expect(await createInvite(null, form({ expires_days: "14" }))).toEqual({
      ok: false,
      error: "Not authorised.",
    });
    expect(api()).toEqual([]);
    roles = ["admin"];
    respond = () => err(503, "api_unavailable", "Down.");
    expect(await createInvite(null, form({ expires_days: "14" }))).toEqual({
      ok: false,
      error: "Down.",
      retryable: true,
    });
  });

  it("revokes an open invite", async () => {
    respond = () => Response.json({ id: "inv1", status: "revoked" });
    const r = await revokeInvite("inv1");
    expect(r.ok).toBe(true);
    expect(api()).toEqual([
      {
        path: "/v1/admin/astrologer-invites/inv1/revoke",
        method: "POST",
        auth: "Bearer admin-token",
        body: undefined,
      },
    ]);
    expect(revalidatePath).toHaveBeenCalledWith("/supply");
  });

  it("explains 409 invite_used", async () => {
    respond = () => err(409, "invite_used", "Invite already used");
    expect(await revokeInvite("inv1")).toMatchObject({
      ok: false,
      error: "This invite has already been used, so it cannot be revoked.",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects a malformed id without a request", async () => {
    expect((await revokeInvite("../x")).ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("content items", () => {
  const fields = {
    title: "Purnima explainer",
    kind: "article",
    locale: "en",
    status: "idea",
    due_date: "2026-10-26",
    url: "",
    notes: "",
  };

  it("creates with the contract body", async () => {
    respond = () => Response.json({ id: "c1" }, { status: 201 });
    const r = await saveContentItem(null, null, form(fields));
    expect(r.ok).toBe(true);
    expect(api()).toEqual([
      {
        path: "/v1/admin/content-items",
        method: "POST",
        auth: "Bearer admin-token",
        body: { ...fields, url: null, notes: null },
      },
    ]);
    expect(revalidatePath).toHaveBeenCalledWith("/content");
  });

  it("updates with PATCH", async () => {
    respond = () => Response.json({ id: "c1" });
    const r = await saveContentItem(
      "c1",
      null,
      form({ ...fields, status: "published", url: "/learn/purnima" }),
    );
    expect(r.ok).toBe(true);
    expect(api()[0]).toMatchObject({
      path: "/v1/admin/content-items/c1",
      method: "PATCH",
      body: { status: "published", url: "/learn/purnima" },
    });
  });

  it("validates on the server too: published needs a URL; http is refused", async () => {
    expect(await saveContentItem(null, null, form({ ...fields, status: "published" }))).toEqual({
      ok: false,
      error: "A published item needs its URL.",
    });
    expect(
      (await saveContentItem(null, null, form({ ...fields, url: "http://x.example" }))).ok,
    ).toBe(false);
    expect(calls).toEqual([]);
  });

  it("deletes, and explains a missing item", async () => {
    respond = () => new Response(null, { status: 204 });
    expect((await deleteContentItem("c1")).ok).toBe(true);
    expect(api()[0]).toMatchObject({ path: "/v1/admin/content-items/c1", method: "DELETE" });
    respond = () => err(404, "not_found", "Not found");
    expect(await deleteContentItem("c1")).toMatchObject({
      ok: false,
      error: "This item no longer exists. Reload the page.",
    });
  });
});
