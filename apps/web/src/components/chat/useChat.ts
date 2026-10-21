"use client";

import { CHAT_LIMITS, type ChatMessage, type ServerEvent, type SessionView } from "@astro/shared";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { call, refreshWallet } from "@/lib/billing/client";
import {
  ChatConnection,
  defaultWsBase,
  type ConnStatus,
  type SocketCtor,
  type TicketResult,
} from "@/lib/chat/connection";
import { chatReducer, cleanMessage, initialChatState, isTerminal } from "@/lib/chat/reducer";

export type LoadState = "loading" | "signed_out" | "not_found" | "error" | "ready";

const POLL_MS = 5000;
const TYPING_SEND_EVERY_MS = 3000;

/**
 * Lets a caller see each socket event as it arrives, before React renders it (a call drops its
 * audio room on `ended` straight away). Set `.current`; it is read on every event.
 */
export type EventTap = { current: ((e: ServerEvent) => void) | null };

/** Everything the chat page needs: session, messages, socket status and actions. */
export function useChat(sessionId: string, tapRef?: EventTap) {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [load, setLoad] = useState<LoadState>("loading");
  const [conn, setConn] = useState<ConnStatus>("connecting");
  const connRef = useRef<ChatConnection | null>(null);
  const lastSeqRef = useRef(0);
  const pendingRef = useRef(state.pending);
  const lastTypingSent = useRef(0);
  const base = `/api/sessions/${encodeURIComponent(sessionId)}`;

  useEffect(() => {
    lastSeqRef.current = state.lastSeq;
    pendingRef.current = state.pending;
  }, [state.lastSeq, state.pending]);

  const fetchSession = useCallback(async () => {
    const r = await call<SessionView>(base);
    if (r.ok) {
      dispatch({ type: "session", session: r.data });
      setLoad("ready");
    } else if (r.status === 401) setLoad("signed_out");
    else if (r.status === 404) setLoad("not_found");
    else setLoad((l) => (l === "ready" ? l : "error"));
  }, [base]);

  useEffect(() => {
    // First load after mount: the session is behind the httpOnly cookie, so client-only.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchSession();
  }, [fetchSession]);

  const status = state.session?.status ?? null;
  const terminal = status ? isTerminal(status) : false;
  const ready = load === "ready";

  // Socket for any open session: it pushes state changes while waiting and carries the chat.
  useEffect(() => {
    if (!ready || terminal) return;
    const c = new ChatConnection({
      wsBase: defaultWsBase(),
      Socket: WebSocket as unknown as SocketCtor,
      getTicket: async (): Promise<TicketResult> => {
        const r = await call<{ ticket: string; path: string; ws_base?: string }>(
          `${base}/ws-ticket`,
          {
            method: "POST",
          },
        );
        return r.ok ? { ok: true, ...r.data } : { ok: false, status: r.status };
      },
      loadMessages: async (after) => {
        const r = await call<{ items: ChatMessage[] }>(`${base}/messages?after_seq=${after}`);
        return r.ok ? r.data.items : null;
      },
      lastSeq: () => lastSeqRef.current,
      onEvent: (event) => {
        tapRef?.current?.(event);
        dispatch({ type: "server", event, now: Date.now() });
      },
      onBackfill: (messages) => dispatch({ type: "backfill", messages }),
      onStatus: (s) => {
        setConn(s);
        if (s === "open") {
          // Resend what did not get through; the server de-duplicates by client_id.
          for (const p of pendingRef.current)
            if (p.status === "sending")
              c.send({ type: "message", client_id: p.client_id, text: p.text });
        }
      },
    });
    connRef.current = c;
    c.start();
    const wake = () => c.reconnectNow();
    const visible = () => document.visibilityState === "visible" && c.reconnectNow();
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", visible);
      c.stop();
      connRef.current = null;
    };
  }, [ready, terminal, base, tapRef]);

  // While waiting for the astrologer, also poll (the socket may not be up yet).
  const waiting = status === "queued" || status === "requested" || status === "accepted";
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(() => void fetchSession(), POLL_MS);
    return () => clearInterval(id);
  }, [waiting, fetchSession]);

  // When it ends: one authoritative read (billed totals, can_review) and a fresh balance.
  useEffect(() => {
    if (!terminal) return;
    // fetchSession sets state only after its request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchSession();
    void refreshWallet();
    // The transcript, e.g. when an ended chat is opened later from the wallet.
    void call<{ items: ChatMessage[] }>(`${base}/messages?after_seq=${lastSeqRef.current}`).then(
      (r) => r.ok && dispatch({ type: "backfill", messages: r.data.items }),
    );
  }, [terminal, fetchSession, base]);

  const send = useCallback((text: string): boolean => {
    const clean = cleanMessage(text, CHAT_LIMITS.maxMessageChars);
    if (!clean) return false;
    const client_id = crypto.randomUUID();
    dispatch({ type: "send", client_id, text: clean, now: Date.now() });
    connRef.current?.send({ type: "message", client_id, text: clean });
    return true;
  }, []);

  const retry = useCallback((client_id: string) => {
    const p = pendingRef.current.find((m) => m.client_id === client_id);
    if (!p) return;
    dispatch({ type: "retry", client_id });
    connRef.current?.send({ type: "message", client_id, text: p.text });
  }, []);

  const typing = useCallback(() => {
    const now = Date.now();
    if (now - lastTypingSent.current < TYPING_SEND_EVERY_MS) return;
    if (connRef.current?.send({ type: "typing" })) lastTypingSent.current = now;
  }, []);

  const act = useCallback(
    async (action: "cancel" | "end"): Promise<boolean> => {
      const r = await call<SessionView>(`${base}/${action}`, { method: "POST" });
      if (r.ok) dispatch({ type: "session", session: r.data });
      else void fetchSession();
      return r.ok;
    },
    [base, fetchSession],
  );

  const reconnect = useCallback(() => connRef.current?.reconnectNow(), []);

  return { state, load, conn, send, retry, typing, act, reconnect, reload: fetchSession };
}
