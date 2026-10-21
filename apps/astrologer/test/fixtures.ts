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
