import type { SessionView } from "@astro/shared";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: () => undefined }),
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/lib/marketplace/data", () => ({ featuredAstrologers: async () => [] }));
vi.mock("next-intl/server", async () => {
  const en = (await import("../messages/en.json")).default as Record<string, unknown>;
  const hi = (await import("../messages/hi.json")).default as Record<string, unknown>;
  return {
    getTranslations: async ({ locale, namespace }: { locale: string; namespace: string }) => {
      const root = (locale === "hi" ? hi : en)[namespace] as Record<string, string>;
      return (key: string) => root[key];
    },
  };
});

import enCore from "../messages/en.json" with { type: "json" };
import enBilling from "../messages/en/billing.json" with { type: "json" };
import enMarket from "../messages/en/marketplace.json" with { type: "json" };
import hiCore from "../messages/hi.json" with { type: "json" };
import hiBilling from "../messages/hi/billing.json" with { type: "json" };
import hiMarket from "../messages/hi/marketplace.json" with { type: "json" };
import nextConfig from "../next.config";
import { CallRoom } from "../src/components/call/CallRoom";
import type { useChat } from "../src/components/chat/useChat";
import { ExpertCta } from "../src/components/ExpertCta";
import { outcomeKey } from "../src/components/marketplace/StartConsult";
import { IntentKeys } from "../src/lib/billing/idempotency";
import { requestSession } from "../src/lib/billing/start";
import { initialChatState } from "../src/lib/chat/reducer";
import {
  availabilityRows,
  cleanSlots,
  timeOfDay,
  weekdayName,
} from "../src/lib/marketplace/availability";

function render(node: ReactNode, locale: "en" | "hi" = "en") {
  const messages =
    locale === "en"
      ? { ...enCore, ...enMarket, ...enBilling }
      : { ...hiCore, ...hiMarket, ...hiBilling };
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Kolkata">
      {node}
    </NextIntlClientProvider>,
  );
}

describe("starting a call from the profile", () => {
  type Post = Parameters<typeof requestSession>[1];
  const base = { astrologerId: "a2", pricePerMinPaise: 1250, balancePaise: 1000 };

  function poster(...answers: { status: number; body: Record<string, unknown> }[]) {
    const sent: { url: string; init: Record<string, unknown> }[] = [];
    const post = (async (url: string, init: Record<string, unknown>) => {
      sent.push({ url, init });
      const a = answers.shift()!;
      return a.status >= 200 && a.status < 300
        ? { ok: true, status: a.status, data: a.body }
        : { ok: false, status: a.status, error: { code: "unexpected_error", ...a.body } };
    }) as unknown as Post;
    return { post, sent };
  }

  it("creates {kind: call} with an Idempotency-Key and opens the session page", async () => {
    const { post, sent } = poster({ status: 201, body: { id: "s9" } });
    const keys = new IntentKeys(() => "key-call-000001");
    const r = await requestSession({ ...base, kind: "call", free: false, keys }, post);
    expect(r).toEqual({ ok: true, id: "s9" });
    expect(sent[0]).toEqual({
      url: "/api/sessions",
      init: {
        method: "POST",
        body: { astrologer_id: "a2", kind: "call", free: false },
        idempotencyKey: "key-call-000001",
      },
    });
  });

  it("free first call sends free: true", async () => {
    const { post, sent } = poster({ status: 201, body: { id: "s9" } });
    await requestSession({ ...base, kind: "call", free: true, keys: new IntentKeys() }, post);
    expect(sent[0]!.init.body).toEqual({ astrologer_id: "a2", kind: "call", free: true });
  });

  it("maps 402, 409 session_open and 409 call_unavailable like chat, worded for calls", async () => {
    const { post } = poster(
      {
        status: 402,
        body: { code: "insufficient_funds", minutes_affordable: 0, required_paise: 2500 },
      },
      { status: 409, body: { code: "session_open", session_id: "s1" } },
      { status: 409, body: { code: "call_unavailable" } },
      { status: 500, body: { code: "upstream_error" } },
    );
    const keys = new IntentKeys();
    const go = () => requestSession({ ...base, kind: "call", free: false, keys }, post);
    expect(await go()).toEqual({
      ok: false,
      outcome: { kind: "insufficient", minutes: 0, required: 2500, suggest: 10000 },
    });
    expect(await go()).toEqual({ ok: false, outcome: { kind: "open", sessionId: "s1" } });
    const unavailable = await go();
    expect(unavailable).toEqual({
      ok: false,
      outcome: { kind: "message", key: "callUnavailable" },
    });
    expect(outcomeKey("call", "callUnavailable")).toBe("callUnavailable");
    expect(outcomeKey("call", "chatUnavailable")).toBe("callUnavailable");
    expect(outcomeKey("call", "generic")).toBe("callGeneric");
    expect(outcomeKey("chat", "generic")).toBe("generic");
    const generic = await go();
    expect(!generic.ok && generic.outcome).toEqual({ kind: "message", key: "generic" });
    for (const k of ["callUnavailable", "callGeneric", "callSignIn", "callOff"])
      expect((enBilling.billing.start as Record<string, string>)[k]).toBeTruthy();
  });

  it("a network error keeps the key so pressing Call again retries the same request", async () => {
    const { post, sent } = poster(
      { status: 0, body: { code: "network_error" } },
      { status: 201, body: { id: "s9" } },
      { status: 201, body: { id: "s10" } },
    );
    const keys = new IntentKeys();
    const go = () => requestSession({ ...base, kind: "call", free: false, keys }, post);
    await go();
    await go();
    await go();
    const k = sent.map((s) => s.init.idempotencyKey);
    expect(k[0]).toBe(k[1]);
    expect(k[2]).not.toBe(k[1]);
  });
});

describe("availability formatting", () => {
  const words = {
    range: (a: string, b: string) => `${a} to ${b}`,
    pair: (a: string, b: string) => `${a} and ${b}`,
  };

  it("weekday 0 is Monday, in both languages", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((d) => weekdayName(d, "en", "short"))).toEqual([
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
      "Sat",
      "Sun",
    ]);
    expect(weekdayName(0, "hi", "long")).toBe("सोमवार");
    expect(weekdayName(6, "hi", "long")).toBe("रविवार");
  });

  it("shows IST wall-clock times as given (no conversion)", () => {
    expect(timeOfDay(9 * 60, "en")).toBe("9:00 am");
    expect(timeOfDay(17 * 60 + 45, "en")).toBe("5:45 pm");
    expect(timeOfDay(24 * 60, "en")).toBe("12:00 am");
  });

  it("orders by weekday and time and merges consecutive days with the same hours", () => {
    const rows = availabilityRows(
      {
        timezone: "Asia/Kolkata",
        slots: [
          { weekday: 5, start: "10:00", end: "13:00" },
          { weekday: 4, start: "18:00", end: "21:00" },
          { weekday: 0, start: "18:00", end: "21:00" },
          { weekday: 1, start: "18:00", end: "21:00" },
          { weekday: 2, start: "18:00", end: "21:00" },
          { weekday: 4, start: "07:00", end: "08:15" },
        ],
      },
      "en",
      words,
    );
    expect(rows).toEqual([
      { days: "Mon–Wed", daysLong: "Monday to Wednesday", times: "6:00 pm – 9:00 pm" },
      { days: "Fri", daysLong: "Friday", times: "7:00 am – 8:15 am, 6:00 pm – 9:00 pm" },
      { days: "Sat", daysLong: "Saturday", times: "10:00 am – 1:00 pm" },
    ]);
  });

  it("empty, missing or malformed schedules show nothing", () => {
    expect(availabilityRows(null, "en", words)).toEqual([]);
    expect(availabilityRows(undefined, "en", words)).toEqual([]);
    expect(availabilityRows({ timezone: "Asia/Kolkata", slots: [] }, "en", words)).toEqual([]);
    expect(
      cleanSlots([
        { weekday: 7 as 0, start: "10:00", end: "11:00" },
        { weekday: 1, start: "11:00", end: "10:00" },
        { weekday: 1, start: "9am", end: "10:00" },
      ]),
    ).toEqual([]);
  });
});

describe("security headers", () => {
  it("Permissions-Policy allows the microphone for our own origin only; camera stays off", async () => {
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === "/:path*")!;
    const policy = all.headers.find((h) => h.key === "Permissions-Policy")!.value;
    expect(policy).toContain("microphone=(self)");
    expect(policy).toContain("camera=()");
    expect(policy).toContain("geolocation=()");
    expect(policy).not.toMatch(/microphone=\*/);
  });
});

describe("consultations are live (cta.status)", () => {
  it("offers chat and voice calls without urgency, in both languages", async () => {
    const en = renderToStaticMarkup(await ExpertCta({ locale: "en" }));
    expect(en).toContain("Consultations are open.");
    expect(en).toContain("Chat with astrologers who offer chat");
    expect(en).toContain("voice calls");
    expect(en).not.toMatch(/soon|hurry|only \d|limited|left/i);
    const hi = renderToStaticMarkup(await ExpertCta({ locale: "hi" }));
    expect(hi).toContain("परामर्श अब शुरू हो चुके हैं।");
    expect(hi).toContain("वॉइस कॉल");
    expect(hi).not.toContain("जल्द");
  });
});

describe("call page (before joining)", () => {
  const session: SessionView = {
    id: "s1",
    kind: "call",
    status: "accepted",
    end_reason: null,
    role: "user",
    astrologer: { id: "a2", slug: "meera-joshi", display_name: "Meera Joshi" },
    client_label: "Client 7Q",
    price_per_min_paise: 1250,
    is_free: false,
    free_minutes: null,
    queue: null,
    created_at: "2026-10-21T10:00:00Z",
    accepted_at: "2026-10-21T10:00:30Z",
    started_at: null,
    ended_at: null,
    billed_minutes: 0,
    billed_paise: 0,
    minutes_left: 9,
    can_review: false,
  };
  const chat = (s: SessionView) =>
    ({
      state: { ...initialChatState, session: s },
      load: "ready",
      conn: "open",
      send: () => true,
      retry: () => undefined,
      typing: () => undefined,
      act: async () => true,
      reconnect: () => undefined,
      reload: async () => undefined,
    }) as unknown as ReturnType<typeof useChat>;

  it("explains the microphone, then offers Join; no text box, nothing billed yet", () => {
    const html = render(
      <CallRoom chat={chat(session)} session={session} tapRef={{ current: null }} />,
    );
    expect(html).toContain("Meera Joshi accepted your call");
    expect(html).toContain("your browser will ask to use your microphone");
    expect(html).toContain(">Join call with microphone</button>");
    expect(html).toContain(">Cancel call request</button>");
    expect(html).toContain("you are not charged");
    expect(html).toMatch(/role="status" aria-live="polite"[^>]*>Meera Joshi accepted your call/);
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain('data-testid="elapsed"');
    const hi = render(
      <CallRoom chat={chat(session)} session={session} tapRef={{ current: null }} />,
      "hi",
    );
    expect(hi).toContain("माइक्रोफ़ोन के साथ कॉल में जुड़ें");
  });

  it("a reloaded active call offers to rejoin; an ended call shows the summary", () => {
    const active = { ...session, status: "active" as const, started_at: "2026-10-21T10:01:00Z" };
    expect(
      render(<CallRoom chat={chat(active)} session={active} tapRef={{ current: null }} />),
    ).toContain(">Rejoin call</button>");
    const ended = {
      ...active,
      status: "completed" as const,
      end_reason: "insufficient_funds" as const,
      ended_at: "2026-10-21T10:05:00Z",
      billed_minutes: 4,
      billed_paise: 5000,
      can_review: true,
    };
    const html = render(<CallRoom chat={chat(ended)} session={ended} tapRef={{ current: null }} />);
    expect(html).toContain("Call ended");
    expect(html).toContain("The call ended because your balance ran out.");
    expect(html).toContain("Call time: 4:00");
    expect(html).toContain("How was your call?");
  });
});
