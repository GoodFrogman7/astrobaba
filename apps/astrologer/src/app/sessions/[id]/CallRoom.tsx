"use client";

import type { CallToken, ChatMessage, SessionView } from "@astro/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useReducer, useRef, useState } from "react";
import { CallAudio, CallTokenError } from "@/lib/call/audio";
import { createLiveKitRoom, requestMicrophone } from "@/lib/call/livekit-room";
import {
  callAudioReducer,
  callPhaseText,
  FAILURE_TEXT,
  initialCallAudio,
  joinedText,
  MIC_HELP,
  wantsAudio,
  type MicProblem,
} from "@/lib/call/state";
import { chatReducer, initialChatState, isTerminal, type ChatState } from "@/lib/chat/reducer";
import { ChatConnection, TicketError, type SocketLike } from "@/lib/chat/socket";
import { endReasonText, formatElapsed, formatRate, formatRupees } from "@/lib/format";

const MIC_PROBLEMS: readonly string[] = ["denied", "not_found", "in_use", "error"];

/**
 * Voice call room. The control socket is the same as for chat (heartbeat for the meter, state,
 * `call` presence, `ended`), without a text box. Audio goes through LiveKit only; nothing is
 * recorded. The client is shown by their label only.
 */
export function CallRoom({ initial }: { initial: SessionView }) {
  const id = initial.id;
  const router = useRouter();
  const [state, dispatch] = useReducer(chatReducer, initial, (s) =>
    initialChatState("astrologer", s),
  );
  const [audio, audioDispatch] = useReducer(callAudioReducer, initialCallAudio);
  const stateRef = useRef<ChatState>(state);
  const conn = useRef<ChatConnection | null>(null);
  const call = useRef<CallAudio | null>(null);
  const sink = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    stateRef.current = state;
  });

  // Control socket: same ticket flow as chat. Messages are only system markers on a call.
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
    if (!isTerminal(initial.status)) c.start();
    const wake = () => {
      if (document.visibilityState === "visible") c.reconnectNow();
    };
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
      c.stop();
    };
  }, [id, initial.status, router]);

  // Audio controller, created once per call and torn down with the page.
  useEffect(() => {
    const a = new CallAudio({
      getToken: async () => {
        const r = await fetch(`/api/sessions/${encodeURIComponent(id)}/call-token`, {
          method: "POST",
        });
        if (!r.ok) {
          const b = (await r.json().catch(() => ({}))) as { code?: string };
          throw new CallTokenError(r.status, b.code);
        }
        return (await r.json()) as CallToken;
      },
      requestMic: requestMicrophone,
      createRoom: (events) => createLiveKitRoom(events, () => sink.current),
      dispatch: audioDispatch,
    });
    call.current = a;
    const leave = () => a.leave();
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      a.leave();
      call.current = null;
    };
  }, [id]);

  const s = state.session ?? initial;
  const ended = isTerminal(s.status);
  // A close reason only counts while the socket is closed ("Use this tab instead" reconnects).
  const want = wantsAudio(s.status, state.connection === "closed" ? state.closeReason : null);

  // Join while the call can be joined and this tab owns the socket; leave on `ended`/4000,
  // on a replaced socket (another tab has the call) and when the session is over.
  useEffect(() => {
    const a = call.current;
    if (!a) return;
    if (want) a.join();
    else a.leave();
  }, [want]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const serverNow = now + state.serverOffsetMs;
  const elapsed = s.started_at
    ? (s.ended_at ? Date.parse(s.ended_at) : serverNow) - Date.parse(s.started_at)
    : 0;
  const who = joinedText(state.callJoined, s.client_label);
  const micProblem = MIC_PROBLEMS.includes(audio.mic) ? (audio.mic as MicProblem) : null;
  const connected = audio.status === "connected";

  async function toggleMute() {
    const next = !muted;
    await call.current?.setMuted(next);
    if (call.current) setMuted(call.current.isMuted);
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
        setEndError("Could not end the call. Try again.");
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
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">Voice call</p>
          <h1 className="text-xl font-semibold">Call with {s.client_label}</h1>
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

      {/* Remote audio elements are attached here by the LiveKit adapter. */}
      <div ref={sink} hidden />

      <p role="status" aria-live="polite" className="mt-4 text-lg font-medium">
        {callPhaseText(s.status, audio.status, state.callJoined)}
      </p>

      <SocketBanner state={state} ended={ended} onRetry={() => conn.current?.start()} />

      {!ended && (
        <section aria-labelledby="who-h" className="mt-4 rounded-md border border-border p-4">
          <h2 id="who-h" className="text-sm font-semibold">
            In the call
          </h2>
          <ul className="mt-2 space-y-1 text-sm">
            <li className="flex items-center gap-2">
              <Dot on={state.callJoined?.astrologer === true} />
              You: {who.you}
              {connected && (muted ? " · muted" : " · microphone on")}
            </li>
            <li className="flex items-center gap-2">
              <Dot on={state.callJoined?.user === true} />
              {who.client}
            </li>
          </ul>
        </section>
      )}

      {audio.playbackBlocked && connected && (
        <div className="mt-4 rounded-md border-2 border-accent p-4">
          <p className="text-sm">Your browser paused the call audio until you tap.</p>
          <button
            type="button"
            onClick={() => void call.current?.enableAudio()}
            className="mt-2 rounded-sm bg-primary px-4 py-2 font-medium text-primary-fg"
          >
            Tap to enable audio
          </button>
        </div>
      )}

      {lowBalance(state, ended)}

      {!ended && audio.status === "failed" && audio.failure && (
        <div role="alert" className="mt-4 rounded-md border border-danger p-4 text-sm">
          <p className="font-medium">{FAILURE_TEXT[audio.failure]}</p>
          {audio.failure === "mic" && micProblem && <p className="mt-1">{MIC_HELP[micProblem]}</p>}
          {audio.failure === "signed_out" ? (
            <Link href="/login" className="mt-2 inline-block underline">
              Sign in
            </Link>
          ) : audio.failure !== "not_joinable" && audio.failure !== "unavailable" && want ? (
            <button
              type="button"
              onClick={() => call.current?.retry()}
              className="mt-2 rounded-sm bg-primary px-3 py-1.5 text-primary-fg"
            >
              Try again
            </button>
          ) : null}
        </div>
      )}
      {!ended && connected && micProblem && (
        <p role="alert" className="mt-4 text-sm text-danger">
          {MIC_HELP[micProblem]}
        </p>
      )}

      {ended ? (
        <section className="mt-6 rounded-md border border-border bg-surface p-4">
          <h2 className="font-semibold">Call ended</h2>
          <p className="mt-1 text-sm">{endReasonText(s.end_reason, "call")}</p>
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
      ) : (
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button
            type="button"
            aria-pressed={muted}
            disabled={!connected}
            onClick={() => void toggleMute()}
            className="rounded-sm border border-border px-4 py-2 font-medium disabled:opacity-60"
          >
            {muted ? "Unmute" : "Mute"}
          </button>
          {confirmEnd ? (
            <>
              <span className="text-sm font-medium">End this call for both of you?</span>
              <button
                type="button"
                disabled={ending}
                onClick={() => void end()}
                className="rounded-sm bg-danger px-4 py-2 text-primary-fg disabled:opacity-60"
              >
                Yes, end call
              </button>
              <button
                type="button"
                onClick={() => setConfirmEnd(false)}
                className="rounded-sm border border-border px-4 py-2"
              >
                Keep talking
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={s.status !== "active"}
              onClick={() => setConfirmEnd(true)}
              className="rounded-sm border border-danger px-4 py-2 text-danger disabled:opacity-60"
            >
              End call
            </button>
          )}
          {endError && <span className="text-sm text-danger">{endError}</span>}
        </div>
      )}
      {!ended && (
        <p className="mt-4 text-xs text-muted">
          Muting only silences your microphone; billing continues while the call is active. Keep
          this tab open: closing it drops you from the call. Calls are not recorded.
        </p>
      )}
    </main>
  );
}

function lowBalance(state: ChatState, ended: boolean) {
  if (state.lowBalanceMinutes === null || ended) return null;
  return (
    <p className="mt-3 text-sm text-accent">
      The client has about {state.lowBalanceMinutes} minute
      {state.lowBalanceMinutes === 1 ? "" : "s"} of balance left.
    </p>
  );
}

function Dot({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block size-2.5 rounded-full ${on ? "bg-success" : "border border-muted"}`}
    />
  );
}

function SocketBanner({
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
  if (state.connection === "connecting") text = "Connecting to the call service…";
  else if (state.connection === "reconnecting") {
    text = "Connection to the call service lost. Reconnecting…";
  } else if (state.connection === "closed" && state.closeReason === "replaced") {
    text = "This call is open in another tab or device, so this tab left the call.";
    retry = true;
  } else if (state.connection === "closed" && state.closeReason === "forbidden") {
    text = "You can't open this call.";
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
