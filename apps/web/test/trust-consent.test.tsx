import type { ConsentState } from "@astro/shared";
import { NextIntlClientProvider } from "next-intl";
import { NextRequest } from "next/server";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import enTrust from "../messages/en/trust.json" with { type: "json" };
import hiTrust from "../messages/hi/trust.json" with { type: "json" };
import policies from "../../../data/legal/policies.json" with { type: "json" };

const jar = new Map<string, string>();
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
  }),
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, target }: { href: string; children: ReactNode; target?: string }) => (
    <a href={href} target={target}>
      {children}
    </a>
  ),
}));

import { GET as getConsents, POST as postConsents } from "../src/app/api/me/consents/route";
import { ConsentForm } from "../src/components/trust/ConsentForm";
import { call, consentRetryKey } from "../src/lib/billing/client";
import { IntentKeys } from "../src/lib/billing/idempotency";
import { outcomeFor, requestSession } from "../src/lib/billing/start";
import { askQuestion } from "../src/lib/revenue/ai";
import { orderErrorOutcome } from "../src/lib/revenue/buy";
import {
  acceptConsents,
  isConsentRequired,
  kindsToAsk,
  missingKinds,
  requestConsent,
  setConsentHandler,
  validateConsent,
  type Fetcher,
} from "../src/lib/trust/consent";

const VERSION = policies.version;

const state = (o: Partial<ConsentState> = {}): ConsentState => ({
  version: VERSION,
  required: ["age_18", "terms", "privacy"],
  missing: ["age_18", "terms", "privacy"],
  accepted: [],
  current: false,
  ...o,
});

type Sent = { url: string; method: string; headers: Record<string, string>; body: unknown };
let sent: Sent[];
let answers: Response[];

beforeEach(() => {
  jar.clear();
  sent = [];
  answers = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      sent.push({
        url,
        method: init.method ?? "GET",
        headers: (init.headers ?? {}) as Record<string, string>,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return answers.shift() ?? Response.json({}, { status: 200 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const consent403 = () =>
  Response.json(
    { code: "consent_required", missing: ["age_18", "terms"], version: VERSION },
    { status: 403 },
  );

describe("403 consent_required opens the consent step and retries", () => {
  it("asks once, then sends the same request again with a derived Idempotency-Key", async () => {
    const asked: string[][] = [];
    const off = setConsentHandler(async (missing) => {
      asked.push(missing);
      return true;
    });
    answers = [consent403(), Response.json({ id: "ord_1", status: "created" }, { status: 201 })];
    const r = await call<{ id: string }>("/api/wallet/recharge-orders", {
      method: "POST",
      body: { amount_paise: 50000 },
      idempotencyKey: "intent-key-0001",
    });
    off();
    expect(r).toEqual({ ok: true, status: 201, data: { id: "ord_1", status: "created" } });
    expect(asked).toEqual([["age_18", "terms"]]);
    expect(sent.map((s) => [s.url, s.method, s.headers["idempotency-key"]])).toEqual([
      ["/api/wallet/recharge-orders", "POST", "intent-key-0001"],
      ["/api/wallet/recharge-orders", "POST", "intent-key-0001-c"],
    ]);
    expect(sent[1]!.body).toEqual({ amount_paise: 50000 });
  });

  it("returns the original 403 when the user closes the step (no retry)", async () => {
    const off = setConsentHandler(async () => false);
    answers = [consent403()];
    const r = await call("/api/sessions", { method: "POST", body: {}, idempotencyKey: "k-123456" });
    off();
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    expect(sent).toHaveLength(1);
  });

  it("without a mounted step (tests, print pages) the 403 comes straight back", async () => {
    answers = [consent403()];
    const r = await call("/api/ai/conversations/c1/questions", { method: "POST", body: {} });
    expect(r.status).toBe(403);
    expect(sent).toHaveLength(1);
  });

  it("other 403s (e.g. free_session_unavailable) never open the step", async () => {
    const handler = vi.fn(async () => true);
    const off = setConsentHandler(handler);
    answers = [Response.json({ code: "free_session_unavailable" }, { status: 403 })];
    await call("/api/sessions", { method: "POST", body: {} });
    off();
    expect(handler).not.toHaveBeenCalled();
    expect(isConsentRequired(403, { code: "consent_required" })).toBe(true);
    expect(isConsentRequired(422, { code: "consent_required" })).toBe(false);
  });

  it("several refused requests share one consent step", async () => {
    let resolve!: (ok: boolean) => void;
    const handler = vi.fn(() => new Promise<boolean>((r) => (resolve = r)));
    const off = setConsentHandler(handler);
    const a = requestConsent(["terms"]);
    const b = requestConsent(["age_18"]);
    resolve(true);
    expect(await Promise.all([a, b])).toEqual([true, true]);
    expect(handler).toHaveBeenCalledTimes(1);
    off();
  });

  it("starting a session goes through after acceptance (end to end with requestSession)", async () => {
    const off = setConsentHandler(async () => true);
    answers = [consent403(), Response.json({ id: "s9" }, { status: 201 })];
    const keys = new IntentKeys(() => "session-key-01");
    const r = await requestSession({
      astrologerId: "a2",
      kind: "chat",
      free: false,
      pricePerMinPaise: 1000,
      balancePaise: 5000,
      keys,
    });
    off();
    expect(r).toEqual({ ok: true, id: "s9" });
    expect(sent[1]!.headers["idempotency-key"]).toBe("session-key-01-c");
  });

  it("the derived key stays within the 128-character limit", () => {
    expect(consentRetryKey("x".repeat(128))).toHaveLength(128);
    expect(consentRetryKey("abc12345")).toBe("abc12345-c");
  });

  it("a closed step leaves each flow with a plain explanation", async () => {
    const e = { code: "consent_required", missing: ["terms"] };
    expect(outcomeFor(403, e, { pricePerMinPaise: 1000, balancePaise: 0 })).toEqual({
      kind: "message",
      key: "consentRequired",
    });
    expect(orderErrorOutcome(403, e, 49900, 0)).toEqual({
      kind: "message",
      key: "consentRequired",
    });
    const post = (async () => ({ ok: false, status: 403, error: e })) as unknown as typeof call;
    expect(await askQuestion("c1", "When?", { keys: new IntentKeys(), balance: 0 }, post)).toEqual({
      kind: "message",
      key: "consentRequired",
    });
    for (const m of [enTrust, hiTrust]) expect(m.trust.consent.errors.terms).toBeTruthy();
  });
});

describe("consent step", () => {
  it("asks the user kinds that are not accepted at the current version", () => {
    expect(kindsToAsk(state())).toEqual(["age_18", "terms", "privacy"]);
    expect(
      kindsToAsk(
        state({
          accepted: [
            { kind: "age_18", version: VERSION, accepted_at: "2026-10-21T06:00:00Z" },
            { kind: "terms", version: "2026-01-01", accepted_at: "2026-01-02T06:00:00Z" },
          ],
        }),
      ),
    ).toEqual(["terms", "privacy"]);
    // Never asks for the astrologer terms on the client site.
    expect(kindsToAsk(state({ required: ["astrologer_terms"] }), ["astrologer_terms"])).toEqual([
      "age_18",
      "terms",
      "privacy",
    ]);
    expect(missingKinds({ missing: ["terms", "bogus", 3] })).toEqual(["terms"]);
  });

  it("both boxes must be ticked by the user", () => {
    const kinds = ["age_18", "terms", "privacy"] as const;
    expect(validateConsent([...kinds], { adult: false, terms: false })).toEqual(["age", "terms"]);
    expect(validateConsent([...kinds], { adult: true, terms: false })).toEqual(["terms"]);
    expect(validateConsent([...kinds], { adult: true, terms: true })).toEqual([]);
    expect(validateConsent(["terms"], { adult: false, terms: true })).toEqual([]);
  });

  it("posts the version the user read; a stale version re-reads the new one", async () => {
    const calls: { url: string; init?: unknown }[] = [];
    const replies: Awaited<ReturnType<Fetcher>>[] = [
      { ok: false, status: 409, error: { code: "consent_version_stale" } },
      { ok: true, status: 200, data: { signed_in: true, ...state({ version: "2026-11-01" }) } },
    ];
    const fetcher = (async (url: string, init?: unknown) => {
      calls.push({ url, init });
      return replies.shift()!;
    }) as Fetcher;
    const r = await acceptConsents(VERSION, ["age_18", "terms", "privacy"], fetcher);
    expect(calls[0]).toEqual({
      url: "/api/me/consents",
      init: { method: "POST", body: { version: VERSION, kinds: ["age_18", "terms", "privacy"] } },
    });
    expect(r.kind).toBe("stale");
    expect(r.kind === "stale" && r.state?.version).toBe("2026-11-01");
    const ok = await acceptConsents(VERSION, ["terms"], (async () => ({
      ok: true,
      status: 200,
      data: state({ current: true }),
    })) as Fetcher);
    expect(ok.kind).toBe("accepted");
  });

  it("renders unticked boxes, links to both policies and the version", () => {
    for (const [locale, messages] of [
      ["en", enTrust],
      ["hi", hiTrust],
    ] as const) {
      const html = renderToStaticMarkup(
        <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Kolkata">
          <ConsentForm
            state={state()}
            kinds={["age_18", "terms", "privacy"]}
            onAccepted={() => undefined}
          />
        </NextIntlClientProvider>,
      );
      for (const id of ["consent-age", "consent-terms"]) {
        const box = new RegExp(`<input[^>]*data-testid="${id}"[^>]*>`).exec(html)?.[0] ?? "";
        expect(box).toContain('type="checkbox"');
        expect(box).toContain("required");
        expect(box).not.toMatch(/\bchecked\b/);
      }
      expect(html).toContain('href="/terms" target="_blank"');
      expect(html).toContain('href="/privacy" target="_blank"');
      expect(html).toContain(messages.trust.consent.age);
      expect(html).toContain(VERSION);
    }
  });
});

describe("/api/me/consents", () => {
  const req = (method: string, body?: unknown) =>
    new NextRequest("http://localhost:3000/api/me/consents", {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });

  it("signed out is {signed_in: false} without calling the API", async () => {
    const res = await getConsents(req("GET"));
    expect(await res.json()).toEqual({ signed_in: false });
    expect(sent).toHaveLength(0);
  });

  it("signed in: forwards with the Bearer token and adds signed_in", async () => {
    jar.set("ap_session", "tok-123");
    answers = [Response.json(state(), { status: 200 })];
    const res = await getConsents(req("GET"));
    expect(await res.json()).toEqual({ signed_in: true, ...state() });
    expect(sent[0]!.url).toBe("http://localhost:8000/v1/me/consents");
    expect(sent[0]!.headers.authorization).toBe("Bearer tok-123");
  });

  it("POST passes only a version and known kinds", async () => {
    jar.set("ap_session", "tok-123");
    expect((await postConsents(req("POST", { version: VERSION, kinds: ["x"] }))).status).toBe(422);
    expect((await postConsents(req("POST", { version: "", kinds: ["terms"] }))).status).toBe(422);
    expect(sent).toHaveLength(0);
    answers = [Response.json(state({ current: true }), { status: 200 })];
    const res = await postConsents(
      req("POST", { version: VERSION, kinds: ["age_18", "terms", "privacy"], extra: 1 }),
    );
    expect(res.status).toBe(200);
    expect(sent[0]!.body).toEqual({ version: VERSION, kinds: ["age_18", "terms", "privacy"] });
  });
});
