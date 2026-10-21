import type { ConsentState, DataExport } from "@astro/shared";
import { NextIntlClientProvider } from "next-intl";
import { NextRequest } from "next/server";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import enCore from "../messages/en.json" with { type: "json" };
import enMarket from "../messages/en/marketplace.json" with { type: "json" };
import enTrust from "../messages/en/trust.json" with { type: "json" };
import hiCore from "../messages/hi.json" with { type: "json" };
import hiMarket from "../messages/hi/marketplace.json" with { type: "json" };
import hiTrust from "../messages/hi/trust.json" with { type: "json" };

const MESSAGES = {
  en: { ...enCore, ...enMarket, ...enTrust },
  hi: { ...hiCore, ...hiMarket, ...hiTrust },
};

const jar = new Map<string, string>();
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
  }),
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import {
  DELETE as cancelDeletionRoute,
  POST as postDeletion,
} from "../src/app/api/me/deletion/route";
import { POST as postExport } from "../src/app/api/me/export/route";
import { GET as exportFile } from "../src/app/api/me/exports/[id]/file/route";
import {
  ConsentSummary,
  DeletionPanel,
  ExportList,
  ExportMessage,
  ProfileSummary,
} from "../src/components/trust/AccountView";
import {
  cancelDeletion,
  confirmMatches,
  exportDownloadHref,
  exportsPending,
  loadDeletion,
  loadExports,
  requestDeletion,
  requestExport,
} from "../src/lib/trust/account";
import type { Fetcher } from "../src/lib/trust/consent";

type Locale = "en" | "hi";
function render(node: ReactNode, locale: Locale = "en") {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone="Asia/Kolkata">
      {node}
    </NextIntlClientProvider>,
  );
}

/** A fake browser fetcher: records calls, answers in order. */
function fake(...replies: Awaited<ReturnType<Fetcher>>[]) {
  const calls: { url: string; init?: { method?: string; body?: unknown } }[] = [];
  const fetcher = (async (url: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ url, init });
    return replies.shift() ?? { ok: false, status: 500, error: { code: "x" } };
  }) as Fetcher;
  return { fetcher, calls };
}
const ok = <T,>(data: T, status = 200) => ({ ok: true as const, status, data });
const err = (status: number, code = "x") => ({ ok: false as const, status, error: { code } });

const exp = (o: Partial<DataExport>): DataExport => ({
  expires_at: null,
  id: "e1",
  status: "ready",
  created_at: "2026-10-21T06:00:00Z",
  download_url: "/v1/me/exports/e1/file?sig=abc",
  ...o,
});

describe("Download my data", () => {
  it("asks for an export and shows it as being prepared", async () => {
    const { fetcher, calls } = fake(ok({ id: "e9", status: "queued" }, 202));
    const r = await requestExport(fetcher);
    expect(calls[0]).toEqual({ url: "/api/me/export", init: { method: "POST", body: {} } });
    expect(r.kind).toBe("queued");
    expect(r.kind === "queued" && r.item).toMatchObject({ id: "e9", status: "queued" });
    expect(exportsPending(r.kind === "queued" ? [r.item] : [])).toBe(true);
  });

  it("one per 24 hours (429), sign-in, errors", async () => {
    expect(await requestExport(fake(err(429, "export_rate_limited")).fetcher)).toEqual({
      kind: "tooSoon",
    });
    expect(await requestExport(fake(err(401)).fetcher)).toEqual({ kind: "signin" });
    expect(await requestExport(fake(err(0)).fetcher)).toEqual({ kind: "error", key: "network" });
    const html = render(<ExportMessage outcome={{ kind: "tooSoon" }} />);
    expect(html).toContain(enTrust.trust.account.export.tooSoon);
  });

  it("lists exports (bare list or {items}); only ready ones get a download link", async () => {
    const list = [exp({}), exp({ id: "e2", status: "queued", download_url: null })];
    expect(await loadExports(fake(ok(list)).fetcher)).toEqual(list);
    expect(await loadExports(fake(ok({ items: list })).fetcher)).toEqual(list);
    expect(await loadExports(fake(err(401)).fetcher)).toBe("signin");
    expect(exportDownloadHref(list[0]!)).toBe("/api/me/exports/e1/file");
    expect(exportDownloadHref(list[1]!)).toBeNull();
    const html = render(
      <ExportList items={[...list, exp({ id: "e3", status: "failed", download_url: null })]} />,
      "hi",
    );
    expect(html).toContain('href="/api/me/exports/e1/file"');
    expect(html).not.toContain("/api/me/exports/e2/file");
    expect(html).toContain(hiTrust.trust.account.export.status.queued);
    expect(html).toContain(hiTrust.trust.account.export.failedHelp);
    expect(render(<ExportList items={[]} />)).toContain(enTrust.trust.account.export.none);
  });
});

describe("Delete my account", () => {
  it("sends nothing until DELETE is typed exactly", async () => {
    const { fetcher, calls } = fake(ok({ id: "d1", status: "requested" }, 202));
    expect(confirmMatches("delete")).toBe(false);
    expect(confirmMatches(" DELETE ")).toBe(true);
    expect(await requestDeletion("Delete", fetcher)).toEqual({ kind: "invalid" });
    expect(calls).toHaveLength(0);
    const r = await requestDeletion("DELETE", fetcher);
    expect(calls[0]).toEqual({
      url: "/api/me/deletion",
      init: { method: "POST", body: { confirm: "DELETE" } },
    });
    expect(r).toEqual({ kind: "requested", request: { id: "d1", status: "requested" } });
  });

  it("reads the open request (404 = none) and cancels it with DELETE", async () => {
    expect(await loadDeletion(fake(err(404, "not_found")).fetcher)).toBe("none");
    expect(await loadDeletion(fake(ok({ id: "d1", status: "requested" })).fetcher)).toEqual({
      id: "d1",
      status: "requested",
    });
    const { fetcher, calls } = fake(ok({ id: "d1", status: "cancelled" }));
    expect(await cancelDeletion(fetcher)).toEqual({ kind: "cancelled" });
    expect(calls[0]).toEqual({ url: "/api/me/deletion", init: { method: "DELETE" } });
  });

  it("explains what is deleted and kept, then asks for the typed confirmation", () => {
    for (const locale of ["en", "hi"] as const) {
      const html = render(<DeletionPanel request="none" />, locale);
      const t = MESSAGES[locale].trust.account.deletion;
      for (const line of [...t.deleted, ...t.kept])
        expect(html).toContain(line.replace(/"/g, "&quot;"));
      expect(html).toContain('data-testid="deletion-form"');
      expect(html).toContain(t.confirmLabel);
      expect(html).not.toContain('data-testid="deletion-pending"');
    }
  });

  it("shows a pending request with its date and a cancel button instead of the form", () => {
    const html = render(
      <DeletionPanel
        request={{ id: "d1", status: "requested", requested_at: "2026-10-21T06:00:00Z" }}
      />,
    );
    expect(html).toContain('data-testid="deletion-pending"');
    expect(html).toContain("21 Oct 2026");
    expect(html).toContain(enTrust.trust.account.deletion.cancel);
    expect(html).not.toContain('data-testid="deletion-form"');
  });
});

describe("profile and consents", () => {
  it("shows the masked phone, consents with versions and dates, and a review button", () => {
    const profile = render(
      <ProfileSummary
        me={{
          id: "u1",
          phone: "+91 98•••••210",
          locale: "hi",
          roles: [],
          astrologer: null,
          created_at: "2026-10-01T06:00:00Z",
        }}
      />,
    );
    expect(profile).toContain("+91 98•••••210");
    expect(profile).toContain('href="/wallet"');
    expect(profile).toContain('href="/account/reports"');
    const consents: ConsentState = {
      version: "2026-10-21",
      required: ["age_18", "terms", "privacy"],
      missing: ["age_18", "privacy"],
      accepted: [{ kind: "terms", version: "2026-09-01", accepted_at: "2026-09-02T06:00:00Z" }],
      current: false,
    };
    const html = render(<ConsentSummary consents={consents} onReview={() => undefined} />);
    expect(html).toContain(enTrust.trust.account.kinds.terms);
    expect(html).toContain("version 2026-09-01");
    expect(html).toContain("2 Sept 2026");
    expect(html).toContain("Policy version 2026-10-21 is newer");
    expect(html).toContain(enTrust.trust.account.review);
  });
});

describe("route handlers", () => {
  type Sent = { url: string; method: string; body?: string; headers: Record<string, string> };
  let sent: Sent[];
  let reply: (url: string) => Response;
  beforeEach(() => {
    jar.clear();
    jar.set("ap_session", "tok-123");
    sent = [];
    reply = () => Response.json({}, { status: 200 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        sent.push({
          url,
          method: init.method ?? "GET",
          body: init.body as string | undefined,
          headers: (init.headers ?? {}) as Record<string, string>,
        });
        return reply(url);
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const req = (path: string, method = "GET", body?: unknown) =>
    new NextRequest(`http://localhost:3000${path}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  it("deletion: only the confirmation word passes; cancel is a DELETE", async () => {
    expect((await postDeletion(req("/api/me/deletion", "POST", { confirm: "yes" }))).status).toBe(
      422,
    );
    expect(sent).toHaveLength(0);
    reply = () => Response.json({ id: "d1", status: "requested" }, { status: 202 });
    const res = await postDeletion(req("/api/me/deletion", "POST", { confirm: "DELETE", x: 1 }));
    expect(res.status).toBe(202);
    expect(JSON.parse(sent[0]!.body!)).toEqual({ confirm: "DELETE" });
    await cancelDeletionRoute(req("/api/me/deletion", "DELETE"));
    expect(sent[1]).toMatchObject({
      url: "http://localhost:8000/v1/me/deletion",
      method: "DELETE",
    });
  });

  it("export: forwards; 429 is relayed with its code", async () => {
    reply = () =>
      Response.json({ detail: { code: "export_rate_limited", message: "x" } }, { status: 429 });
    const res = await postExport(req("/api/me/export", "POST"));
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe("export_rate_limited");
    expect(sent[0]!.headers.authorization).toBe("Bearer tok-123");
  });

  it("export download streams only a /v1/me/exports file from our API, never cached", async () => {
    reply = (url) =>
      url.endsWith("/v1/me/exports")
        ? Response.json([exp({}), exp({ id: "e2", download_url: "https://evil.example/x" })])
        : new Response('{"profile":{}}', { status: 200 });
    const res = await exportFile(req("/api/me/exports/e1/file"), {
      params: Promise.resolve({ id: "e1" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(sent[1]!.url).toBe("http://localhost:8000/v1/me/exports/e1/file?sig=abc");
    const evil = await exportFile(req("/api/me/exports/e2/file"), {
      params: Promise.resolve({ id: "e2" }),
    });
    expect(evil.status).toBe(409);
    expect(sent.some((s) => s.url.includes("evil.example"))).toBe(false);
    jar.clear();
    const out = await exportFile(req("/api/me/exports/e1/file"), {
      params: Promise.resolve({ id: "e1" }),
    });
    expect(out.status).toBe(401);
  });
});
