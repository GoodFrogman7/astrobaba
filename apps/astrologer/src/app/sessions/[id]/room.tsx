"use client";

import type { ChatMessage, SafetyResources, SessionView } from "@astro/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useReducer, useRef, useState, type Dispatch } from "react";
import {
  chatReducer,
  initialChatState,
  isTerminal,
  type ChatAction,
  type ChatState,
} from "@/lib/chat/reducer";
import { ChatConnection, loadAll, TicketError, type SocketLike } from "@/lib/chat/socket";
import { endReasonText, formatElapsed, formatRate, formatRupees } from "@/lib/format";
import { normalizeResources, safetyKey } from "@/lib/trust";

/** Parts shared by the chat room and the call room: both run on the same control socket. */

/**
 * The control socket (ticket → WebSocket → backfill), reconnecting when the browser comes back
 * online or the tab becomes visible. A finished chat loads its transcript once instead.
 */
export function useSessionSocket(initial: SessionView) {
  const id = initial.id;
  const router = useRouter();
  const [state, dispatch] = useReducer(chatReducer, initial, (s) =>
    initialChatState("astrologer", s),
  );
  const stateRef = useRef<ChatState>(state);
  const conn = useRef<ChatConnection | null>(null);

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
    if (!isTerminal(initial.status)) c.start();
    else if (initial.kind === "chat") {
      void loadAll(fetchMessages, dispatch, 0, () => !cancelled).catch(() => undefined);
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
  }, [id, initial.kind, initial.status, router]);

  return { state, dispatch, conn };
}

/**
 * The `safety` flag for this session (trust.md §3) and the helplines to show with it. The flag
 * is remembered for the tab (sessionStorage), so a reload keeps the guidance on screen even if
 * the server does not repeat the event. Helplines come with the page; if that load failed they
 * are fetched once when the flag is raised.
 */
export function useSafety(
  id: string,
  safety: string | null,
  dispatch: Dispatch<ChatAction>,
  initialResources: SafetyResources | null,
) {
  const [resources, setResources] = useState(initialResources);
  const [failed, setFailed] = useState(false);
  const fetched = useRef(false);

  useEffect(() => {
    let raised: string | null = null;
    try {
      raised = window.sessionStorage.getItem(safetyKey(id));
    } catch {
      /* storage blocked: only a live event shows the panel */
    }
    if (raised !== "self_harm") return;
    // Deferred so the effect body itself never updates state.
    const t = setTimeout(
      () =>
        dispatch({ type: "server", event: { type: "safety", kind: "self_harm" }, now: Date.now() }),
      0,
    );
    return () => clearTimeout(t);
  }, [id, dispatch]);

  useEffect(() => {
    if (!safety) return;
    try {
      window.sessionStorage.setItem(safetyKey(id), safety);
    } catch {
      /* storage blocked */
    }
    if (resources || fetched.current) return;
    fetched.current = true;
    void fetch("/api/safety/resources", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        const n = normalizeResources(b);
        if (n) setResources(n);
        else setFailed(true);
      })
      .catch(() => setFailed(true));
  }, [id, safety, resources]);

  return { resources, failed };
}

/** A clock that ticks every second, for the elapsed timer and typing indicator. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** End the session for both sides, after a confirm step in the caller's UI. */
export function useEndSession(id: string, dispatch: Dispatch<ChatAction>, failText: string) {
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);

  async function end() {
    setEnding(true);
    setEndError(null);
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(id)}/end`, { method: "POST" });
      if (r.ok) {
        const body = (await r.json().catch(() => null)) as SessionView | null;
        if (body && body.id === id) dispatch({ type: "session", session: body });
      } else {
        setEndError(failText);
      }
    } catch {
      setEndError("Network error. Try again.");
    } finally {
      setEnding(false);
      setConfirmEnd(false);
    }
  }

  return { confirmEnd, setConfirmEnd, endError, ending, end };
}

export function RoomHeader({ s, serverNow }: { s: SessionView; serverNow: number }) {
  const elapsed = s.started_at
    ? (s.ended_at ? Date.parse(s.ended_at) : serverNow) - Date.parse(s.started_at)
    : 0;
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
      <div>
        {s.kind === "call" && (
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">Voice call</p>
        )}
        <h1 className="text-xl font-semibold">
          {s.kind === "call" ? "Call" : "Chat"} with {s.client_label}
        </h1>
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
  );
}

const BANNER = {
  chat: {
    connecting: "Connecting…",
    reconnecting: "Connection lost. Reconnecting…",
    replaced: "This chat is open in another tab or device, so this tab stopped updating.",
    forbidden: "You can't open this chat.",
  },
  call: {
    connecting: "Connecting to the call service…",
    reconnecting: "Connection to the call service lost. Reconnecting…",
    replaced: "This call is open in another tab or device, so this tab left the call.",
    forbidden: "You can't open this call.",
  },
};

export function ConnectionBanner({
  state,
  kind,
  onRetry,
}: {
  state: ChatState;
  kind: SessionView["kind"];
  onRetry: () => void;
}) {
  const text = BANNER[kind];
  const closed = state.connection === "closed" ? state.closeReason : null;
  const line =
    state.connection === "connecting"
      ? text.connecting
      : state.connection === "reconnecting"
        ? text.reconnecting
        : closed === "replaced" || closed === "forbidden"
          ? text[closed]
          : null;
  if (!line) return null;
  return (
    <p role="status" className="mt-3 rounded-md border border-border bg-surface px-4 py-2 text-sm">
      {line}{" "}
      {closed === "replaced" && (
        <button type="button" className="underline" onClick={onRetry}>
          Use this tab instead
        </button>
      )}
    </p>
  );
}

export function LowBalance({ minutes }: { minutes: number | null }) {
  if (minutes === null) return null;
  return (
    <p className="mt-3 text-sm text-accent">
      The client has about {minutes} minute
      {minutes === 1 ? "" : "s"} of balance left.
    </p>
  );
}

export function EndedSummary({ s, className }: { s: SessionView; className: string }) {
  return (
    <section className={`${className} rounded-md border border-border bg-surface p-4`}>
      <h2 className="font-semibold">{s.kind === "call" ? "Call" : "Chat"} ended</h2>
      <p className="mt-1 text-sm">{endReasonText(s.end_reason, s.kind)}</p>
      <p className="mt-1 text-sm text-muted">
        Billed {s.billed_minutes} min
        {!s.is_free && ` · ${formatRupees(s.billed_paise)}`}. Your share appears under{" "}
        <Link href="/earnings" className="underline">
          Earnings
        </Link>
        .
      </p>
      <Link href="/" className="mt-3 inline-block underline">
        Back to the console
      </Link>
    </section>
  );
}
