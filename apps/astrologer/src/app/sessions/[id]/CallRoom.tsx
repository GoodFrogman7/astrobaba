"use client";

import type { CallToken, SessionView } from "@astro/shared";
import Link from "next/link";
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
import { isTerminal } from "@/lib/chat/reducer";
import {
  ConnectionBanner,
  EndedSummary,
  LowBalance,
  RoomHeader,
  useEndSession,
  useNow,
  useSessionSocket,
} from "./room";

const MIC_PROBLEMS: readonly string[] = ["denied", "not_found", "in_use", "error"];

/**
 * Voice call room. The control socket is the same as for chat (heartbeat for the meter, state,
 * `call` presence, `ended`), without a text box. Audio goes through LiveKit only; nothing is
 * recorded. The client is shown by their label only.
 */
export function CallRoom({ initial }: { initial: SessionView }) {
  const id = initial.id;
  const { state, dispatch, conn } = useSessionSocket(initial);
  const { confirmEnd, setConfirmEnd, endError, ending, end } = useEndSession(
    id,
    dispatch,
    "Could not end the call. Try again.",
  );
  const [audio, audioDispatch] = useReducer(callAudioReducer, initialCallAudio);
  const call = useRef<CallAudio | null>(null);
  const sink = useRef<HTMLDivElement>(null);
  const now = useNow();
  const [muted, setMuted] = useState(false);

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

  const who = joinedText(state.callJoined, s.client_label);
  const micProblem = MIC_PROBLEMS.includes(audio.mic) ? (audio.mic as MicProblem) : null;
  const connected = audio.status === "connected";

  async function toggleMute() {
    const next = !muted;
    await call.current?.setMuted(next);
    if (call.current) setMuted(call.current.isMuted);
  }

  return (
    <main id="main" className="mx-auto flex max-w-3xl flex-col px-4 py-6">
      <RoomHeader s={s} serverNow={now + state.serverOffsetMs} />

      {/* Remote audio elements are attached here by the LiveKit adapter. */}
      <div ref={sink} hidden />

      <p role="status" aria-live="polite" className="mt-4 text-lg font-medium">
        {callPhaseText(s.status, audio.status, state.callJoined)}
      </p>

      {!ended && (
        <ConnectionBanner state={state} kind="call" onRetry={() => conn.current?.start()} />
      )}

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

      {!ended && <LowBalance minutes={state.lowBalanceMinutes} />}

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
        <EndedSummary s={s} className="mt-6" />
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

function Dot({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block size-2.5 rounded-full ${on ? "bg-success" : "border border-muted"}`}
    />
  );
}
