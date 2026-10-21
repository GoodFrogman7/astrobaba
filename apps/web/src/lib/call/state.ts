import type { ParticipantRole, SessionView } from "@astro/shared";
import type { ConnStatus } from "@/lib/chat/connection";
import { isTerminal } from "@/lib/chat/reducer";

/**
 * Client-side state of a voice call's audio, as a pure reducer (docs/api/portal.md §1). The
 * session itself (accepted → active → completed) still comes only from the server through the
 * control socket; nothing here decides billing. This only tracks our side of the LiveKit room.
 */
export type MediaStatus =
  /** Not in the audio room (before joining, or after we left). */
  | "idle"
  /** Asking for the microphone and a room token. */
  | "preparing"
  /** Opening the LiveKit connection. */
  | "connecting"
  | "connected"
  | "reconnecting"
  /** The room went away without us leaving (network gave up, room closed). */
  | "dropped";

export type MicIssue = "denied" | "not_found" | "in_use" | "unsupported" | "other";

export interface AudioOutput {
  deviceId: string;
  label: string;
}

export interface CallState {
  media: MediaStatus;
  mic: MicIssue | null;
  /** Error code when the token or the connection failed (not a microphone problem). */
  joinError: string | null;
  muted: boolean;
  /** The browser refused to autoplay the astrologer's audio; needs a tap (room.startAudio()). */
  audioBlocked: boolean;
  outputs: AudioOutput[];
  outputId: string | null;
}

export const initialCallState: CallState = {
  media: "idle",
  mic: null,
  joinError: null,
  muted: false,
  audioBlocked: false,
  outputs: [],
  outputId: null,
};

export type CallAction =
  | { type: "join_start" }
  | { type: "connecting" }
  | { type: "connected"; audioBlocked: boolean }
  | { type: "mic_failed"; issue: MicIssue }
  | { type: "join_failed"; code: string }
  | { type: "reconnecting" }
  | { type: "reconnected" }
  | { type: "dropped" }
  | { type: "left" }
  | { type: "muted"; muted: boolean }
  | { type: "audio_blocked"; blocked: boolean }
  | { type: "outputs"; outputs: AudioOutput[]; active: string | null };

export function callReducer(state: CallState, a: CallAction): CallState {
  switch (a.type) {
    case "join_start":
      return { ...initialCallState, media: "preparing", outputs: state.outputs };
    case "connecting":
      return { ...state, media: "connecting" };
    case "connected":
      return { ...state, media: "connected", audioBlocked: a.audioBlocked };
    case "mic_failed":
      return { ...state, media: "idle", mic: a.issue, joinError: null };
    case "join_failed":
      return { ...state, media: "idle", joinError: a.code, mic: null };
    case "reconnecting":
      return state.media === "connected" ? { ...state, media: "reconnecting" } : state;
    case "reconnected":
      return state.media === "reconnecting" ? { ...state, media: "connected" } : state;
    case "dropped":
      return state.media === "idle" ? state : { ...state, media: "dropped", audioBlocked: false };
    case "left":
      // Idempotent: leave() may run on every render while the session is over.
      if (state.media === "idle" && !state.audioBlocked && !state.muted) return state;
      return { ...state, media: "idle", audioBlocked: false, muted: false };
    case "muted":
      return { ...state, muted: a.muted };
    case "audio_blocked":
      return { ...state, audioBlocked: a.blocked };
    case "outputs":
      return { ...state, outputs: a.outputs, outputId: a.active };
    default:
      return state;
  }
}

/** getUserMedia / LiveKit errors → what we can tell the user to do about it. */
export function micIssue(error: unknown): MicIssue {
  const name =
    error && typeof error === "object" && "name" in error ? String(error.name) : String(error);
  if (/NotAllowed|PermissionDenied|Security/i.test(name)) return "denied";
  if (/NotFound|DevicesNotFound|Overconstrained/i.test(name)) return "not_found";
  if (/NotReadable|TrackStart|AbortError|DeviceInUse/i.test(name)) return "in_use";
  if (/Unsupported|NotSupported/i.test(name)) return "unsupported";
  return "other";
}

/**
 * Who is in the audio room. The `call` socket event is authoritative; before one arrives, an
 * `active` call means both have joined (the server activates only then), otherwise nobody yet.
 */
export function joinedMap(
  session: SessionView | null,
  fromSocket: Record<ParticipantRole, boolean> | null,
): Record<ParticipantRole, boolean> {
  if (fromSocket) return fromSocket;
  const both = session?.status === "active";
  return { user: both, astrologer: both };
}

/**
 * Leave the audio room at once when the session is over (an `ended` frame, a terminal state from
 * a poll, or the socket closed with 4000) or we may not be in it (4003 / signed out). The server
 * also deletes the room, so nothing is heard after the meter stops.
 */
export function shouldDisconnect(status: SessionView["status"] | null, conn: ConnStatus): boolean {
  if (status && isTerminal(status)) return true;
  return conn === "closed" || conn === "forbidden";
}

export type CallScreen =
  /** queued / requested: the shared waiting room with cancel. */
  | "waiting"
  /** accepted or active but not in the room: explain the microphone, then "Join". */
  | "join"
  | "mic_blocked"
  | "join_failed"
  | "connecting"
  /** We are in the room; the astrologer has not joined the audio yet. */
  | "waiting_astrologer"
  /** Both in the room; waiting for the server to make the session active. */
  | "starting"
  | "in_call"
  | "ended";

export function callScreen(
  session: SessionView,
  call: CallState,
  joined: Record<ParticipantRole, boolean>,
): CallScreen {
  const s = session.status;
  if (isTerminal(s)) return "ended";
  if (s === "queued" || s === "requested") return "waiting";
  if (call.media === "preparing" || call.media === "connecting") return "connecting";
  if (call.media === "idle" || call.media === "dropped") {
    if (call.mic) return "mic_blocked";
    if (call.joinError) return "join_failed";
    return "join";
  }
  // connected or reconnecting
  if (s === "active") return "in_call";
  return joined.astrologer ? "starting" : "waiting_astrologer";
}
