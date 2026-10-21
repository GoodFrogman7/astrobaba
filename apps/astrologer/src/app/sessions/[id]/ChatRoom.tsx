"use client";

import { CHAT_LIMITS, type SafetyResources, type SessionView } from "@astro/shared";
import { useEffect, useRef, useState } from "react";
import { BlockedNotice } from "@/components/BlockedNotice";
import { SafetyPanel } from "@/components/SafetyPanel";
import { canSend, isPeerTyping, isTerminal } from "@/lib/chat/reducer";
import {
  ConnectionBanner,
  EndedSummary,
  LowBalance,
  RoomHeader,
  useEndSession,
  useNow,
  useSafety,
  useSessionSocket,
} from "./room";

const SYSTEM_TEXT: Record<string, string> = {
  session_started: "Chat started. Billing runs per minute from now.",
  low_balance: "The client has about one minute of balance left.",
  session_ended: "Chat ended.",
};

export function ChatRoom({
  initial,
  resources: initialResources = null,
}: {
  initial: SessionView;
  resources?: SafetyResources | null;
}) {
  const { state, dispatch, conn } = useSessionSocket(initial);
  const { resources, failed } = useSafety(initial.id, state.safety, dispatch, initialResources);
  const { confirmEnd, setConfirmEnd, endError, ending, end } = useEndSession(
    initial.id,
    dispatch,
    "Could not end the chat. Try again.",
  );
  const [draft, setDraft] = useState("");
  const now = useNow();
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [state.messages.length, state.pending.length]);

  const s = state.session ?? initial;
  const ended = isTerminal(s.status);
  const sendable = canSend(state);
  const trimmed = draft.trim();
  const tooLong = trimmed.length > CHAT_LIMITS.maxMessageChars;

  function send() {
    if (!sendable || !trimmed || tooLong) return;
    const client_id = crypto.randomUUID();
    dispatch({ type: "send", client_id, text: trimmed });
    conn.current?.sendMessage(client_id, trimmed);
    setDraft("");
  }

  return (
    <main id="main" className="mx-auto flex max-w-3xl flex-col px-4 py-6">
      <RoomHeader s={s} serverNow={now + state.serverOffsetMs} />

      {!ended && (
        <ConnectionBanner state={state} kind="chat" onRetry={() => conn.current?.start()} />
      )}

      {s.status === "accepted" && (
        <p className="mt-3 rounded-md border border-border bg-surface px-4 py-3 text-sm">
          You accepted. Waiting for the client to join; billing starts when both of you are
          connected.
        </p>
      )}
      {!ended && <LowBalance minutes={state.lowBalanceMinutes} />}

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
              ) : p.status === "blocked" ? (
                <>
                  Not sent: refused by moderation.{" "}
                  <button
                    type="button"
                    className="underline"
                    onClick={() => {
                      setDraft(p.text);
                      dispatch({ type: "discard", client_id: p.client_id });
                    }}
                  >
                    Edit
                  </button>{" "}
                  <button
                    type="button"
                    className="underline"
                    onClick={() => dispatch({ type: "discard", client_id: p.client_id })}
                  >
                    Remove
                  </button>
                </>
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

      {state.safety && <SafetyPanel resources={resources} failed={failed} kind="chat" />}
      {state.blocked && !ended && (
        <BlockedNotice
          reason={state.blocked.reason}
          onDismiss={() => dispatch({ type: "dismiss_blocked" })}
        />
      )}

      {ended ? (
        <EndedSummary s={s} className="mt-4" />
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
