import type { SessionView } from "@astro/shared";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import helplines from "../../../data/safety/helplines.json" with { type: "json" };
import enCore from "../messages/en.json" with { type: "json" };
import enBilling from "../messages/en/billing.json" with { type: "json" };
import enMarket from "../messages/en/marketplace.json" with { type: "json" };
import enRevenue from "../messages/en/revenue.json" with { type: "json" };
import enTrust from "../messages/en/trust.json" with { type: "json" };
import hiCore from "../messages/hi.json" with { type: "json" };
import hiBilling from "../messages/hi/billing.json" with { type: "json" };
import hiMarket from "../messages/hi/marketplace.json" with { type: "json" };
import hiRevenue from "../messages/hi/revenue.json" with { type: "json" };
import hiTrust from "../messages/hi/trust.json" with { type: "json" };

const MESSAGES = {
  en: { ...enCore, ...enMarket, ...enBilling, ...enRevenue, ...enTrust },
  hi: { ...hiCore, ...hiMarket, ...hiBilling, ...hiRevenue, ...hiTrust },
};

vi.mock("server-only", () => ({}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
  useRouter: () => ({ push: () => undefined }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next-intl/server", async () => {
  const { createTranslator: make } = await import("next-intl");
  return {
    getTranslations: async ({ locale, namespace }: { locale: "en" | "hi"; namespace?: string }) =>
      make({ locale, messages: MESSAGES[locale], namespace: namespace as never }),
    setRequestLocale: () => undefined,
  };
});

import ChatPage from "../src/app/[locale]/chat/[sessionId]/page";
import { CallRoom } from "../src/components/call/CallRoom";
import {
  ActiveChat,
  balanceWarning,
  Ended,
  SessionReport,
  SessionSafety,
} from "../src/components/chat/ChatRoom";
import type { useChat } from "../src/components/chat/useChat";
import { QuestionItem } from "../src/components/revenue/AiQuestionItem";
import { chatReducer, initialChatState, type ChatState } from "../src/lib/chat/reducer";
import type { AiQuestion } from "../src/lib/revenue/types";

type Locale = "en" | "hi";

function render(node: ReactNode, locale: Locale = "en") {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone="Asia/Kolkata">
      {node}
    </NextIntlClientProvider>,
  );
}

const session = (o: Partial<SessionView> = {}): SessionView => ({
  id: "s1",
  kind: "chat",
  status: "active",
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
  started_at: "2026-10-21T10:01:00Z",
  ended_at: null,
  billed_minutes: 3,
  billed_paise: 3750,
  minutes_left: 1,
  can_review: false,
  safety_flag: false,
  ...o,
});

const chatOf = (state: ChatState, act = vi.fn(async () => true)) =>
  ({
    state,
    load: "ready",
    conn: "open",
    send: () => true,
    retry: () => undefined,
    typing: () => undefined,
    act,
    reconnect: () => undefined,
    reload: async () => undefined,
  }) as unknown as ReturnType<typeof useChat>;

const telNumbers = (html: string) => [...html.matchAll(/href="tel:([^"]+)"/g)].map((m) => m[1]);
const FILE_NUMBERS = helplines.helplines.map((h) => h.number);

describe("safety event in a consultation", () => {
  const s = session();
  const base: ChatState = { ...initialChatState, session: s };

  it("the reducer turns the flag on (from the event or the session) and never off", () => {
    const now = Date.now();
    const flagged = chatReducer(base, {
      type: "server",
      event: { type: "safety", kind: "self_harm" },
      now,
    });
    expect(flagged.safety).toBe(true);
    const later = chatReducer(flagged, {
      type: "server",
      event: { type: "state", session: s },
      now,
    });
    expect(later.safety).toBe(true);
    const fromSession = chatReducer(initialChatState, {
      type: "session",
      session: session({ safety_flag: true }),
    });
    expect(fromSession.safety).toBe(true);
    expect(initialChatState.safety).toBe(false);
  });

  it("hides the low-balance recharge prompt for the rest of the session", () => {
    const low = chatReducer(base, {
      type: "server",
      event: { type: "low_balance", minutes_left: 1 },
      now: 0,
    });
    expect(balanceWarning(s, low).low).toBe(true);
    const flagged = chatReducer(low, {
      type: "server",
      event: { type: "safety", kind: "self_harm" },
      now: 0,
    });
    expect(balanceWarning(s, flagged).low).toBe(false);
    const again = chatReducer(flagged, {
      type: "server",
      event: { type: "low_balance", minutes_left: 1 },
      now: 0,
    });
    expect(balanceWarning(s, again).low).toBe(false);

    const before = render(<ActiveChat chat={chatOf(low)} session={s} />);
    expect(before).toContain(enBilling.billing.chat.rechargeNewTab);
    expect(before).toContain('href="/wallet"');
    const after = render(<ActiveChat chat={chatOf(again)} session={s} />);
    expect(after).not.toContain(enBilling.billing.chat.rechargeNewTab);
    expect(after).not.toContain('href="/wallet"');
  });

  it("shows a calm crisis panel: helplines from the file, tap-to-call, not-a-helpline, End", () => {
    for (const locale of ["en", "hi"] as const) {
      const flagged = { ...base, safety: true };
      const html = render(<SessionSafety chat={chatOf(flagged)} session={s} />, locale);
      expect(html).toContain('data-testid="crisis-panel"');
      expect(telNumbers(html)).toEqual(FILE_NUMBERS);
      expect(html).toContain(helplines.not_a_helpline[locale]);
      expect(html).toContain('data-testid="crisis-end"');
      expect(html).toContain(MESSAGES[locale].trust.safety.end);
      expect(html).toContain(MESSAGES[locale].trust.safety.upsellPaused);
      expect(html).not.toContain('role="alert"');
    }
    expect(render(<SessionSafety chat={chatOf(base)} session={s} />)).toBe("");
  });

  it("End consultation ends an active session, cancels a waiting one, and is gone after", () => {
    const act = vi.fn(async () => true);
    const flagged = { ...base, safety: true };
    // The button's handler is the `onEnd` prop; check what it calls.
    const element = SessionSafety({ chat: chatOf(flagged, act), session: s });
    void (element as { props: { onEnd: () => Promise<boolean> } }).props.onEnd();
    expect(act).toHaveBeenCalledWith("end");
    const waiting = SessionSafety({
      chat: chatOf(flagged, act),
      session: session({ status: "requested" }),
    });
    void (waiting as { props: { onEnd: () => Promise<boolean> } }).props.onEnd();
    expect(act).toHaveBeenLastCalledWith("cancel");
    const ended = SessionSafety({
      chat: chatOf(flagged, act),
      session: session({ status: "completed" }),
    });
    expect((ended as { props: { onEnd?: unknown } }).props.onEnd).toBeUndefined();
  });

  it("no 'consult again' prompt on the summary after a safety event", () => {
    const done = session({ status: "completed", end_reason: "user_ended" });
    const normal = render(
      <Ended session={done} state={{ ...base, session: done }} onReviewed={() => undefined} />,
    );
    expect(normal).toContain('href="/astrologers/meera-joshi"');
    const flagged = render(
      <Ended
        session={done}
        state={{ ...base, session: done, safety: true }}
        onReviewed={() => undefined}
      />,
    );
    expect(flagged).not.toContain('href="/astrologers/meera-joshi"');
  });

  it("calls show the same panel", () => {
    const call = session({ kind: "call", status: "accepted", started_at: null, safety_flag: true });
    const state = chatReducer(initialChatState, { type: "session", session: call });
    const html = render(
      <CallRoom chat={chatOf(state)} session={call} tapRef={{ current: null }} />,
    );
    expect(html).toContain('data-testid="crisis-panel"');
    expect(telNumbers(html)).toEqual(FILE_NUMBERS);
  });

  it("a report link appears once the astrologer accepted, not while waiting", () => {
    expect(render(<SessionReport session={session()} />)).toContain('data-testid="report-open"');
    expect(render(<SessionReport session={session({ status: "requested" })} />)).toBe("");
  });

  it("every consultation page carries the not-a-helpline notice", async () => {
    for (const locale of ["en", "hi"] as const) {
      const stream = await renderToReadableStream(
        <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone="Asia/Kolkata">
          {await ChatPage({ params: Promise.resolve({ locale, sessionId: "s1" }) })}
        </NextIntlClientProvider>,
      );
      await stream.allReady;
      const html = await new Response(stream).text();
      expect(html).toContain('data-testid="safety-notice"');
      expect(html).toContain(MESSAGES[locale].trust.safety.notice);
      expect(html).toContain('href="/safety"');
    }
  });
});

describe("AI assistant: self-harm", () => {
  const q = (o: Partial<AiQuestion>): AiQuestion => ({
    id: "q1",
    text: "a question",
    status: "blocked",
    answer: null,
    blocked_reason: "self_harm",
    created_at: "2026-10-21T06:00:00Z",
    answered_at: null,
    price_paise: 0,
    refunded: false,
    ...o,
  });

  it("shows the crisis panel and no paid hand-off", () => {
    for (const locale of ["en", "hi"] as const) {
      const html = render(<QuestionItem q={q({})} locale={locale} />, locale);
      expect(html).toContain('data-testid="crisis-panel"');
      expect(telNumbers(html)).toEqual(FILE_NUMBERS);
      expect(html).toContain(helplines.not_a_helpline[locale]);
      expect(html).not.toContain('href="/astrologers"');
      expect(html).not.toContain('data-testid="crisis-end"');
    }
  });

  it("other blocked reasons keep the usual explanation without the panel", () => {
    const html = render(<QuestionItem q={q({ blocked_reason: "medical" })} locale="en" />);
    expect(html).not.toContain('data-testid="crisis-panel"');
    expect(html).toContain('href="/astrologers"');
  });
});
