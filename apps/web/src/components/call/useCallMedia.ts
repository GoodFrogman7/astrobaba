"use client";

import type { CallToken, ServerEvent } from "@astro/shared";
import { useCallback, useEffect, useId, useReducer, useState } from "react";
import type { EventTap, useChat } from "@/components/chat/useChat";
import { call } from "@/lib/billing/client";
import { loadLiveKit } from "@/lib/call/livekit";
import { CallMedia, type MediaElementLike, type TokenResult } from "@/lib/call/media";
import { callReducer, initialCallState, shouldDisconnect } from "@/lib/call/state";

/**
 * The audio half of a call page: joins and leaves the LiveKit room. The session state, the
 * meter and the end of the call all come from the control socket in `useChat`; this hook only
 * follows them. It leaves the room on `ended` (before React renders it), on a terminal state, on
 * socket close 4000 / 4003, on unmount and on page hide.
 */
export function useCallMedia(
  sessionId: string,
  chat: ReturnType<typeof useChat>,
  tapRef: EventTap,
) {
  const [state, dispatch] = useReducer(callReducer, initialCallState);
  // The hidden node that holds the astrologer's <audio> element(s).
  const sinkId = useId();
  const reload = chat.reload;
  const [media] = useState(
    () =>
      new CallMedia({
        load: loadLiveKit,
        getToken: async (): Promise<TokenResult> => {
          const r = await call<CallToken>(
            `/api/sessions/${encodeURIComponent(sessionId)}/call-token`,
            { method: "POST" },
          );
          return r.ok ? { ok: true, data: r.data } : { ok: false, code: r.error.code };
        },
        dispatch,
        mountAudio: (el: MediaElementLike) => {
          document.getElementById(sinkId)?.appendChild(el as unknown as HTMLMediaElement);
        },
      }),
  );

  // Socket events reach us before they are rendered: drop the audio the moment the call ends.
  useEffect(() => {
    tapRef.current = (e: ServerEvent) => {
      if (e.type === "ended") media.leave();
    };
    return () => {
      tapRef.current = null;
    };
  }, [tapRef, media]);

  const status = chat.state.session?.status ?? null;
  const mustLeave = shouldDisconnect(status, chat.conn);
  useEffect(() => {
    if (mustLeave) media.leave();
  }, [mustLeave, media]);

  // The room was closed under us (often the server ending the call): re-read the session.
  const dropped = state.media === "dropped";
  useEffect(() => {
    if (dropped) void reload();
  }, [dropped, reload]);

  useEffect(() => {
    const hide = () => media.leave();
    window.addEventListener("pagehide", hide);
    return () => {
      window.removeEventListener("pagehide", hide);
      media.leave();
    };
  }, [media]);

  const join = useCallback(() => void media.join(), [media]);
  const setMuted = useCallback((m: boolean) => void media.setMuted(m), [media]);
  const startAudio = useCallback(() => void media.startAudio(), [media]);
  const setOutput = useCallback(
    (id: string) => void media.setOutput(id, state.outputs),
    [media, state.outputs],
  );

  return { state, sinkId, join, setMuted, startAudio, setOutput };
}
