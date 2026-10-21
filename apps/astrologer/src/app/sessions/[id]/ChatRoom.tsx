"use client";

import { CHAT_LIMITS, type ChatMessage, type SessionView } from "@astro/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useReducer, useRef, useState } from "react";
import {
  canSend,
  chatReducer,
  initialChatState,
  isPeerTyping,
  isTerminal,
  type ChatState,
} from "@/lib/chat/reducer";
import { ChatConnection, loadAll, TicketError, type SocketLike } from "@/lib/chat/socket";
import { endReasonText, formatElapsed, formatRate, formatRupees } from "@/lib/format";

const SYSTEM_TEXT: Record<string, string> = {
  session_started: "Chat started. Billing runs per minute from now.",
  low_balance: "The client has about one minute of balance left.",
  session_ended: "Chat ended.",
};

function newClientId(): string {
  return crypto.randomUUID();
}

export function ChatRoom({ initial }: { initial: SessionView }) {
  const id = initial.id;
  const router = useRouter();
  const [state, dispatch] = useReducer(chatReducer, initial, (s) =>
    initialChatState("astrologer", s),
  );
  const stateRef = useRef<ChatState>(state);
  const conn = useRef<ChatConnection | null>(null);
  const [draft, setDraft] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    stateRef.current = state;
  });

  useEffect(() => {
    const base = `/api/sessions/${encodeURIComponent(id)}`;
    const fetchMessages = async (after: number, limit: number): Promise<ChatMessage[]> => {
      const r = await fetch(`${base}/messages?after_seq=${after}&limit=${limit}`, {
        cache: "no-store",
      });
      if (r.status === 401) router.replace("/login");
      if (!r.ok) throw new Error(String(r.status));
      return ((await r.json()) as { items: ChatMessage[] }).items;
    };
    const c = new ChatConnection({
      getSocketUrl: async () => {
        const r = await fetch(`${base}/ws-ticket`, { method: "POST" });
        if (!r.ok) throw new TicketError(r.status);
        return ((await r.json()) as { url: string }).url;
      },
      fetchMessages,
      createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
      dispatch,
      getState: () => stateRef.current,
      now: () => Date.now(),
    });
    conn.current = c;
    let cancelled = false;
    if (isTerminal(initial.status)) {
      // Finished chat: read-only transcript, no socket.
      void loadAll(fetchMessages, dispatch, 0, () => !cancelled).catch(() => undefined);
    } else {
      c.start();
    }
    const wake = () => {
      if (document.visibilityState === "visible") c.reconnectNow();
    };
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      cancelled = true;
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
      c.stop();
    };
  }, [id, initial.status, router]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [state.messages.length, state.pending.length]);

  const s = state.session ?? initial;
  const ended = isTerminal(s.status);
  const serverNow = now + state.serverOffsetMs;
  const elapsed = s.started_at
    ? (s.ended_at ? Date.parse(s.ended_at) : serverNow) - Date.parse(s.started_at)
    : 0;
  const sendable = canSend(state);
  const trimmed = draft.trim();
  const tooLong = trimmed.length > CHAT_LIMITS.maxMessageChars;

  function send() {
    if (!sendable || !trimmed || tooLong) return;
    const client_id = newClientId();
    dispatch({ type: "send", client_id, text: trimmed });
    conn.current?.sendMessage(client_id, trimmed);
    setDraft("");
  }

  async function end() {
    setEnding(true);
    setEndError(null);
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(id)}/end`, { method: "POST" });
      if (r.ok) {
        const body = (await r.json().catch(() => null)) as SessionView | null;
        if (body && body.id === id) dispatch({ type: "session", session: body });
      } else {
        setEndError("Could not end the chat. Try again.");
      }
    } catch {
      setEndError("Network error. Try again.");
    } finally {
      setEnding(false);
      setConfirmEnd(false);
    }
  }

  return (
    <main id="main" className="mx-auto flex max-w-3xl flex-col px-4 py-6">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
        <div>
          <h1 className="text-xl font-semibold">Chat with {s.client_label}</h1>
          <p className="text-sm text-muted">
            {s.is_free
              ? `Free session${s.free_minutes ? ` (up to ${s.free_minutes} min)` : ""}`
              : `Paid · ${formatRate(s.price_per_min_paise)}`}
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:text-right">
          <dt className="text-muted">Elapsed</dt>
          <dd className="font-mono tabular-nums" aria-live="off">
            {s.started_at ? formatElapsed(elapsed) : "–"}
          </dd>
          <dt className="text-muted">Billed</dt>
          <dd className="tabular-nums">
            {s.billed_minutes} min
            {!s.is_free && s.billed_paise > 0 && ` · ${formatRupees(s.billed_paise)}`}
          </dd>
        </dl>
      </header>

      <ConnectionBanner state={state} ended={ended} onRetry={() => conn.current?.start()} />

      {s.status === "accepted" && (
        <p className="mt-3 rounded-md border border-border bg-surface px-4 py-3 text-sm">
          You accepted. Waiting for the client to join; billing starts when both of you are
          connected.
        </p>
      )}
      {state.lowBalanceMinutes !== null && !ended && (
        <p className="mt-3 text-sm text-accent">
          The client has about {state.lowBalanceMinutes} minute
          {state.lowBalanceMinutes === 1 ? "" : "s"} of balance left.
        </p>
      )}

      <div
        role="log"
        aria-live="polite"
        aria-label="Messages"
        className="mt-4 min-h-64 flex-1 space-y-2 overflow-y-auto"
      >
        {state.messages.map((m) =>
          m.sender === "system" ? (
            <p key={m.seq} className="text-center text-xs text-muted">
              {SYSTEM_TEXT[m.text.split(":")[0] ?? ""] ?? m.text}
            </p>
          ) : (
            <Bubble key={m.seq} mine={m.sender === "astrologer"} label={s.client_label}>
              {m.text}
            </Bubble>
          ),
        )}
        {state.pending.map((p) => (
          <Bubble key={p.client_id} mine label={s.client_label}>
            {p.text}
            <span className="mt-1 block text-xs opacity-80">
              {p.status === "sending" ? (
                "Sending…"
              ) : (
                <>
                  Not sent.{" "}
                  <button
                    type="button"
                    className="underline"
                    disabled={!sendable}
                    onClick={() => {
                      dispatch({ type: "retry", client_id: p.client_id });
                      conn.current?.sendMessage(p.client_id, p.text);
                    }}
                  >
                    Retry
                  </button>
                </>
              )}
            </span>
          </Bubble>
        ))}
        <div ref={bottom} />
      </div>

      <p className="h-5 text-sm text-muted" aria-live="polite">
        {!ended && isPeerTyping(state, now) ? `${s.client_label} is typing…` : ""}
      </p>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error.code === "rate_limited"
            ? "You are sending too fast. Wait a few seconds."
            : state.error.code === "session_not_active"
              ? "Messages can only be sent while the chat is active."
              : "Something went wrong with the last message."}{" "}
          <button
            type="button"
            className="underline"
            onClick={() => dispatch({ type: "dismiss_error" })}
          >
            Dismiss
          </button>
        </p>
      )}

      {ended ? (
        <section className="mt-4 rounded-md border border-border bg-surface p-4">
          <h2 className="font-semibold">Chat ended</h2>
          <p className="mt-1 text-sm">{endReasonText(s.end_reason)}</p>
          <p className="mt-1 text-sm text-muted">
            Billed {s.billed_minutes} min
            {!s.is_free && ` · ${formatRupees(s.billed_paise)}`}. Earnings detail comes later.
          </p>
          <Link href="/" className="mt-3 inline-block underline">
            Back to the console
          </Link>
        </section>
      ) : (
        <>
          <form
            className="mt-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <label htmlFor="msg" className="sr-only">
              Message
            </label>
            <textarea
              id="msg"
              rows={2}
              value={draft}
              disabled={!sendable}
              onChange={(e) => {
                setDraft(e.target.value);
                conn.current?.typing();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={sendable ? "Type a message" : "You can type once the chat is active"}
              className="flex-1 resize-none rounded-sm border border-border bg-surface px-3 py-2 disabled:opacity-60"
            />
            <button
              disabled={!sendable || !trimmed || tooLong}
              className="self-end rounded-sm bg-primary px-4 py-2 text-primary-fg disabled:opacity-60"
            >
              Send
            </button>
          </form>
          {trimmed.length > CHAT_LIMITS.maxMessageChars - 200 && (
            <p className={`text-xs ${tooLong ? "text-danger" : "text-muted"}`}>
              {trimmed.length}/{CHAT_LIMITS.maxMessageChars} characters
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {confirmEnd ? (
              <>
                <span className="text-sm font-medium">End this chat for both of you?</span>
                <button
                  type="button"
                  disabled={ending}
                  onClick={() => void end()}
                  className="rounded-sm bg-danger px-3 py-1.5 text-sm text-primary-fg disabled:opacity-60"
                >
                  Yes, end chat
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmEnd(false)}
                  className="rounded-sm border border-border px-3 py-1.5 text-sm"
                >
                  Keep chatting
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={s.status !== "active"}
                onClick={() => setConfirmEnd(true)}
                className="rounded-sm border border-danger px-3 py-1.5 text-sm text-danger disabled:opacity-60"
              >
                End chat
              </button>
            )}
            {endError && <span className="text-sm text-danger">{endError}</span>}
          </div>
        </>
      )}
    </main>
  );
}

function Bubble({
  mine,
  label,
  children,
}: {
  mine: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] whitespace-pre-wrap break-words rounded-md px-3 py-2 ${
          mine ? "bg-primary text-primary-fg" : "border border-border bg-surface"
        }`}
      >
        <span className="sr-only">{mine ? "You: " : `${label}: `}</span>
        {children}
      </div>
    </div>
  );
}

function ConnectionBanner({
  state,
  ended,
  onRetry,
}: {
  state: ChatState;
  ended: boolean;
  onRetry: () => void;
}) {
  if (ended) return null;
  let text: string | null = null;
  let retry = false;
  if (state.connection === "connecting") text = "Connecting…";
  else if (state.connection === "reconnecting") text = "Connection lost. Reconnecting…";
  else if (state.connection === "closed" && state.closeReason === "replaced") {
    text = "This chat is open in another tab or device, so this tab stopped updating.";
    retry = true;
  } else if (state.connection === "closed" && state.closeReason === "forbidden") {
    text = "You can't open this chat.";
  }
  if (!text) return null;
  return (
    <p role="status" className="mt-3 rounded-md border border-border bg-surface px-4 py-2 text-sm">
      {text}{" "}
      {retry && (
        <button type="button" className="underline" onClick={onRetry}>
          Use this tab instead
        </button>
      )}
    </p>
  );
}
