import { vi } from "vitest";
import type { ChatMessage, SessionView } from "@astro/shared";

export function session(over: Partial<SessionView> = {}): SessionView {
  return {
    id: "s_1",
    kind: "chat",
    status: "active",
    end_reason: null,
    role: "astrologer",
    astrologer: { id: "a_1", slug: "demo", display_name: "Demo Astrologer 01" },
    client_label: "Client 7Q",
    price_per_min_paise: 2500,
    is_free: false,
    free_minutes: null,
    queue: null,
    created_at: "2026-10-21T10:00:00Z",
    accepted_at: "2026-10-21T10:00:10Z",
    started_at: "2026-10-21T10:00:30Z",
    ended_at: null,
    billed_minutes: 1,
    billed_paise: 2500,
    minutes_left: null,
    can_review: false,
    safety_flag: false,
    ...over,
  };
}

export function msg(seq: number, over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `m_${seq}`,
    seq,
    sender: "user",
    text: `message ${seq}`,
    sent_at: "2026-10-21T10:01:00Z",
    client_id: null,
    ...over,
  };
}

export type FetchMock = ReturnType<
  typeof vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>
>;

/** A mocked core API answering every call with this status, body and headers (plus a cookie). */
export function api(
  status = 200,
  body: unknown = { ok: true },
  headers: Record<string, string> = {},
): FetchMock {
  return vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(
    async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "set-cookie": "upstream=1", ...headers },
      }),
  );
}

export const deps = (f: FetchMock, token: string | null = "tok") => ({
  token: token ?? undefined,
  apiUrl: "http://api.test",
  fetchImpl: f as unknown as typeof fetch,
  wsBase: "wss://api.example",
});

/** The first request the mock received. */
export function sent(f: FetchMock) {
  const [url, init] = f.mock.calls[0]!;
  return {
    url: String(url),
    init: init!,
    headers: init!.headers as Record<string, string>,
    body: init!.body ? JSON.parse(String(init!.body)) : undefined,
  };
}
