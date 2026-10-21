import { ASTROLOGER_REPORT_REASONS } from "@astro/shared";
import { NextIntlClientProvider } from "next-intl";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import enMarket from "../messages/en/marketplace.json" with { type: "json" };
import enTrust from "../messages/en/trust.json" with { type: "json" };
import hiMarket from "../messages/hi/marketplace.json" with { type: "json" };
import hiTrust from "../messages/hi/trust.json" with { type: "json" };

const jar = new Map<string, string>();
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
  }),
}));

import { POST as reportRoute } from "../src/app/api/astrologer-reports/route";
import { ReportForm } from "../src/components/trust/ReportAstrologer";
import { IntentKeys } from "../src/lib/billing/idempotency";
import {
  reportBody,
  REPORT_NOTE_MAX,
  submitReport,
  validateReport,
  type ReportInput,
} from "../src/lib/trust/report";

const MESSAGES = { en: { ...enMarket, ...enTrust }, hi: { ...hiMarket, ...hiTrust } };
const input = (o: Partial<ReportInput> = {}): ReportInput => ({
  astrologerId: "a2",
  sessionId: "s1",
  reason: "fear_selling",
  note: "",
  ...o,
});

function poster(...answers: { status: number; body?: Record<string, unknown> }[]) {
  const sent: { url: string; init: { body: unknown; idempotencyKey: string } }[] = [];
  const post = async (
    url: string,
    init: { method: "POST"; body: unknown; idempotencyKey: string },
  ) => {
    sent.push({ url, init });
    const a = answers.shift()!;
    return a.status >= 200 && a.status < 300
      ? { ok: true as const, status: a.status, data: a.body ?? {} }
      : { ok: false as const, status: a.status, error: { code: "x", ...a.body } };
  };
  return { post, sent };
}

describe("report an astrologer", () => {
  it("needs a contract reason and a note of at most 500 characters", () => {
    expect(validateReport(input({ reason: "" }))).toEqual(["reason"]);
    expect(validateReport(input({ note: "x".repeat(REPORT_NOTE_MAX + 1) }))).toEqual(["note"]);
    expect(validateReport(input({ note: "ठ".repeat(REPORT_NOTE_MAX) }))).toEqual([]);
    expect(REPORT_NOTE_MAX).toBe(500);
  });

  it("sends the body with one Idempotency-Key per report; a network retry reuses it", async () => {
    const { post, sent } = poster({ status: 0 }, { status: 201, body: { id: "r1" } });
    const keys = new IntentKeys(() => "report-key-0001");
    const first = await submitReport(input({ note: "  Kept saying I must pay  " }), keys, post);
    expect(first).toEqual({ kind: "error", key: "network" });
    const second = await submitReport(input({ note: "  Kept saying I must pay  " }), keys, post);
    expect(second).toEqual({ kind: "sent" });
    expect(sent.map((s) => s.init.idempotencyKey)).toEqual(["report-key-0001", "report-key-0001"]);
    expect(sent[1]).toEqual({
      url: "/api/astrologer-reports",
      init: {
        method: "POST",
        body: {
          astrologer_id: "a2",
          reason: "fear_selling",
          session_id: "s1",
          note: "Kept saying I must pay",
        },
        idempotencyKey: "report-key-0001",
      },
    });
    expect(reportBody(input({ sessionId: null }))).toEqual({
      astrologer_id: "a2",
      reason: "fear_selling",
    });
  });

  it("maps one-open-report, sign-in and other errors", async () => {
    const { post } = poster(
      { status: 409, body: { code: "report_open" } },
      { status: 401 },
      { status: 409, body: { code: "own_profile" } },
    );
    const keys = new IntentKeys();
    expect(await submitReport(input(), keys, post)).toEqual({ kind: "duplicate" });
    expect(await submitReport(input(), keys, post)).toEqual({ kind: "signin" });
    expect(await submitReport(input(), keys, post)).toEqual({ kind: "error", key: "generic" });
    expect(await submitReport(input({ reason: "" }), keys, post)).toEqual({
      kind: "invalid",
      errors: ["reason"],
    });
  });

  it("the form lists every contract reason as a radio, with a 500-character note", () => {
    for (const locale of ["en", "hi"] as const) {
      const html = renderToStaticMarkup(
        <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone="Asia/Kolkata">
          <ReportForm astrologerId="a2" sessionId="s1" />
        </NextIntlClientProvider>,
      );
      const radios = [...html.matchAll(/<input[^>]*type="radio"[^>]*value="([^"]+)"/g)].map(
        (m) => m[1],
      );
      expect(radios).toEqual([...ASTROLOGER_REPORT_REASONS]);
      for (const r of ASTROLOGER_REPORT_REASONS)
        expect(html).toContain(MESSAGES[locale].trust.report.reasons[r]);
      expect(html).toContain('maxLength="500"');
      expect(html).not.toMatch(/type="radio"[^>]*checked/);
    }
    const sent = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={MESSAGES.en} timeZone="Asia/Kolkata">
        <ReportForm astrologerId="a2" initial={{ step: "done", outcome: { kind: "sent" } }} />
      </NextIntlClientProvider>,
    );
    expect(sent).toContain(enTrust.trust.report.sent);
  });
});

describe("/api/astrologer-reports", () => {
  let sent: { url: string; body: unknown; headers: Record<string, string> }[];
  beforeEach(() => {
    jar.clear();
    jar.set("ap_session", "tok-123");
    sent = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        sent.push({
          url,
          body: JSON.parse(String(init.body)),
          headers: init.headers as Record<string, string>,
        });
        return Response.json({ id: "r1", status: "open" }, { status: 201 });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const req = (body: unknown, key: string | null = "report-key-0001") =>
    new NextRequest("http://localhost:3000/api/astrologer-reports", {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      body: JSON.stringify(body),
    });

  it("requires an Idempotency-Key and validates before forwarding", async () => {
    const good = { astrologer_id: "a2", reason: "scam" };
    expect((await reportRoute(req(good, null))).status).toBe(400);
    expect((await reportRoute(req({ ...good, reason: "rude" }))).status).toBe(422);
    expect((await reportRoute(req({ ...good, note: "x".repeat(501) }))).status).toBe(422);
    expect((await reportRoute(req({ ...good, astrologer_id: "../x" }))).status).toBe(422);
    expect(sent).toHaveLength(0);
    const res = await reportRoute(req({ ...good, session_id: "s1", note: " hi ", extra: true }));
    expect(res.status).toBe(201);
    expect(sent[0]).toMatchObject({
      url: "http://localhost:8000/v1/reports/astrologer",
      body: { astrologer_id: "a2", reason: "scam", session_id: "s1", note: "hi" },
    });
    expect(sent[0]!.headers["idempotency-key"]).toBe("report-key-0001");
  });
});
