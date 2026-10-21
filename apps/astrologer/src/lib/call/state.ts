import type { ParticipantRole, SessionStatus } from "@astro/shared";
import type { CloseReason } from "../chat/reducer";

/**
 * Audio side of a call (docs/api/portal.md §1). The control socket (chat reducer) owns the
 * session; this state only tracks the LiveKit room, the microphone and audio playback. Pure.
 */

export type AudioStatus =
  "idle" | "mic_check" | "connecting" | "connected" | "reconnecting" | "failed" | "left";

export type MicProblem = "denied" | "not_found" | "in_use" | "error";
export type MicStatus = "unknown" | "on" | "muted" | MicProblem;

export type CallFailure =
  "mic" | "duplicate" | "not_joinable" | "unavailable" | "signed_out" | "connect_failed";

export interface CallAudioState {
  status: AudioStatus;
  mic: MicStatus;
  /** The browser refused to autoplay remote audio until the user taps something. */
  playbackBlocked: boolean;
  /** Remote audio tracks attached to the page. */
  remoteAudio: number;
  failure: CallFailure | null;
}

export type CallAudioAction =
  | { type: "mic_check" }
  | { type: "connecting" }
  | { type: "connected" }
  | { type: "reconnecting" }
  | { type: "mic"; mic: MicStatus }
  | { type: "playback"; canPlay: boolean }
  | { type: "remote_audio"; count: number }
  | { type: "failed"; failure: CallFailure; mic?: MicProblem }
  | { type: "left" };

export const initialCallAudio: CallAudioState = {
  status: "idle",
  mic: "unknown",
  playbackBlocked: false,
  remoteAudio: 0,
  failure: null,
};

export function callAudioReducer(state: CallAudioState, action: CallAudioAction): CallAudioState {
  switch (action.type) {
    case "mic_check":
      return { ...state, status: "mic_check", failure: null };
    case "connecting":
      return { ...state, status: "connecting", failure: null };
    case "connected":
      return { ...state, status: "connected", failure: null };
    case "reconnecting":
      return { ...state, status: "reconnecting", remoteAudio: 0 };
    case "mic":
      return { ...state, mic: action.mic };
    case "playback":
      return { ...state, playbackBlocked: !action.canPlay };
    case "remote_audio":
      return { ...state, remoteAudio: Math.max(0, action.count) };
    case "failed":
      return {
        ...state,
        status: "failed",
        failure: action.failure,
        mic: action.mic ?? state.mic,
        remoteAudio: 0,
        playbackBlocked: false,
      };
    case "left":
      return { ...state, status: "left", remoteAudio: 0, playbackBlocked: false };
  }
}

/**
 * Classify a getUserMedia / LiveKit microphone error by its DOMException name (the same names
 * LiveKit's MediaDeviceFailure uses).
 */
export function micFailure(err: unknown): MicProblem {
  const name =
    err && typeof err === "object" && "name" in err ? String((err as { name: unknown }).name) : "";
  if (["NotAllowedError", "PermissionDeniedError", "SecurityError"].includes(name)) return "denied";
  if (["NotFoundError", "DevicesNotFoundError", "OverconstrainedError"].includes(name)) {
    return "not_found";
  }
  if (["NotReadableError", "TrackStartError", "AbortError"].includes(name)) return "in_use";
  return "error";
}

/** What to tell the astrologer when the microphone cannot be used. */
export const MIC_HELP: Record<MicProblem, string> = {
  denied:
    "Microphone access is blocked for this site. Click the lock or site-settings icon next to the address bar, allow the microphone, then press Try again.",
  not_found: "No microphone was found. Connect a headset or microphone, then press Try again.",
  in_use:
    "The microphone is being used by another app or tab. Close the other call or app, then press Try again.",
  error: "The microphone could not be started. Check your device settings, then press Try again.",
};

const OPEN_FOR_AUDIO: readonly SessionStatus[] = ["accepted", "active"];

/**
 * Whether this tab should be in the audio room: only while the session can still be joined and
 * this tab owns the control socket (a replaced or refused socket means another tab has the call).
 */
export function wantsAudio(status: SessionStatus, closeReason: CloseReason): boolean {
  return OPEN_FOR_AUDIO.includes(status) && closeReason === null;
}

/** Map a failed call-token request to a failure. 5xx/network are retried instead. */
export function tokenFailure(status: number, code?: string): CallFailure | null {
  if (status === 401) return "signed_out";
  if (code === "call_unavailable") return "unavailable";
  if (status === 409 || status === 403 || status === 404) return "not_joinable";
  return null;
}

export const FAILURE_TEXT: Record<CallFailure, string> = {
  mic: "The microphone is not available.",
  duplicate: "This call's audio was opened in another tab or device, so this tab left the audio.",
  not_joinable: "This call can no longer be joined.",
  unavailable: "Voice calls are switched off on the platform right now.",
  signed_out: "You are signed out. Sign in again to rejoin.",
  connect_failed: "Could not connect the audio. Check your connection and press Try again.",
};

/** One line on who is in the audio room, from the socket's `call` event. */
export function joinedText(
  joined: Record<ParticipantRole, boolean> | null,
  clientLabel: string,
): { you: string; client: string } {
  if (!joined) return { you: "Not confirmed yet", client: "Not joined yet" };
  return {
    you: joined.astrologer ? "In the call" : "Not in the call",
    client: joined.user ? `${clientLabel} is in the call` : `${clientLabel} has not joined`,
  };
}

/** Status line for the call header. */
export function callPhaseText(
  status: SessionStatus,
  audio: AudioStatus,
  joined: Record<ParticipantRole, boolean> | null,
): string {
  if (status === "completed" || status === "cancelled" || status === "failed") return "Call ended";
  if (audio === "mic_check") return "Checking your microphone…";
  if (audio === "connecting") return "Connecting audio…";
  if (audio === "reconnecting") return "Audio connection lost. Reconnecting…";
  if (audio === "failed") return "Audio not connected";
  if (status === "accepted") {
    return joined?.user
      ? "The client is here. Billing starts in a moment."
      : "Waiting for the client to join. Billing starts when both of you are connected.";
  }
  if (status === "active") return "Call in progress";
  return "Preparing the call…";
}
