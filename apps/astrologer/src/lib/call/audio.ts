import type { CallToken } from "@astro/shared";
import { backoffMs, browserTimers, type Timers } from "../chat/socket";
import { micFailure, tokenFailure, type CallAudioAction } from "./state";

/**
 * Audio controller for a call: microphone check → call token → LiveKit room → microphone on.
 * Every side effect is injected (the LiveKit adapter lives in ./livekit-room.ts), so the order of
 * steps, retries and teardown are unit-tested with a fake room.
 *
 * The microphone is checked *before* joining the room: joining is what tells the server this
 * side is present (and starts billing once both are in), so the astrologer never sits in a
 * paid call unable to speak.
 */

/** Why the room went away, as far as this controller cares. */
export type DropReason = "client" | "duplicate" | "room_closed" | "other";

export interface AudioRoomEvents {
  onDisconnected(reason: DropReason): void;
  onReconnecting(): void;
  onReconnected(): void;
  onPlayback(canPlay: boolean): void;
  onRemoteAudio(count: number): void;
  onMicError(err: unknown): void;
}

/** The subset of a LiveKit room this controller uses. */
export interface AudioRoom {
  connect(url: string, token: string): Promise<void>;
  setMicrophone(enabled: boolean): Promise<void>;
  startAudio(): Promise<void>;
  canPlayAudio(): boolean;
  disconnect(): Promise<void>;
}

export class CallTokenError extends Error {
  constructor(
    public status: number,
    public code?: string,
  ) {
    super(`call-token ${status}`);
  }
}

export interface CallAudioDeps {
  /** `POST /api/sessions/{id}/call-token`. Throws CallTokenError on an HTTP error. */
  getToken(): Promise<CallToken>;
  /** Ask for microphone permission (and release the probe stream). Throws a DOMException. */
  requestMic(): Promise<void>;
  createRoom(events: AudioRoomEvents): Promise<AudioRoom>;
  dispatch(action: CallAudioAction): void;
  timers?: Timers;
  random?: () => number;
  /** Automatic reconnect attempts before giving up and showing "Try again". */
  maxAttempts?: number;
}

export class CallAudio {
  private room: AudioRoom | null = null;
  private wanted = false;
  private busy = false;
  private attempt = 0;
  private timer: unknown = null;
  private muted = false;
  /** Bumped on every join attempt and on leave, so late results of an old attempt are dropped. */
  private generation = 0;
  private readonly timers: Timers;
  private readonly random: () => number;

  constructor(private readonly deps: CallAudioDeps) {
    this.timers = deps.timers ?? browserTimers;
    this.random = deps.random ?? Math.random;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Join (idempotent while joining or joined). */
  join(): void {
    if (this.wanted && (this.room || this.busy || this.timer !== null)) return;
    this.wanted = true;
    this.attempt = 0;
    void this.connect();
  }

  /** Manual retry after a failure ("Try again"). */
  retry(): void {
    this.clearTimer();
    if (this.room || this.busy) return;
    this.wanted = true;
    this.attempt = 0;
    void this.connect();
  }

  /** Leave the room and stop retrying (session ended, page closed, another tab took over). */
  leave(): void {
    const wasActive = this.wanted || this.room !== null;
    this.wanted = false;
    this.generation += 1;
    this.busy = false;
    this.clearTimer();
    const room = this.room;
    this.room = null;
    if (wasActive) this.deps.dispatch({ type: "left" });
    if (room) void room.disconnect().catch(() => undefined);
  }

  async setMuted(muted: boolean): Promise<void> {
    const room = this.room;
    if (!room) return;
    try {
      await room.setMicrophone(!muted);
      this.muted = muted;
      this.deps.dispatch({ type: "mic", mic: muted ? "muted" : "on" });
    } catch (e) {
      this.deps.dispatch({ type: "mic", mic: micFailure(e) });
    }
  }

  /** Call from a click: lets the browser play remote audio after an autoplay block. */
  async enableAudio(): Promise<void> {
    const room = this.room;
    if (!room) return;
    try {
      await room.startAudio();
    } catch {
      /* still blocked; the button stays */
    }
    this.deps.dispatch({ type: "playback", canPlay: room.canPlayAudio() });
  }

  private clearTimer(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  private async connect(): Promise<void> {
    if (!this.wanted) return;
    const gen = ++this.generation;
    const stale = () => gen !== this.generation || !this.wanted;
    this.busy = true;
    const d = this.deps.dispatch;
    try {
      d({ type: "mic_check" });
      try {
        await this.deps.requestMic();
      } catch (e) {
        if (stale()) return;
        this.wanted = false;
        d({ type: "failed", failure: "mic", mic: micFailure(e) });
        return;
      }
      if (stale()) return;
      d({ type: "connecting" });
      let token: CallToken;
      try {
        token = await this.deps.getToken();
      } catch (e) {
        if (stale()) return;
        const failure = e instanceof CallTokenError ? tokenFailure(e.status, e.code) : null;
        if (failure) {
          this.wanted = false;
          d({ type: "failed", failure });
        } else {
          this.scheduleRetry();
        }
        return;
      }
      if (stale()) return;
      const room = await this.deps.createRoom(this.events(gen));
      if (stale()) return void room.disconnect().catch(() => undefined);
      try {
        await room.connect(token.url, token.token);
      } catch {
        void room.disconnect().catch(() => undefined);
        if (!stale()) this.scheduleRetry();
        return;
      }
      if (stale()) return void room.disconnect().catch(() => undefined);
      this.room = room;
      this.attempt = 0;
      d({ type: "connected" });
      try {
        await room.setMicrophone(!this.muted);
        if (stale()) return;
        d({ type: "mic", mic: this.muted ? "muted" : "on" });
      } catch (e) {
        if (stale()) return;
        // Permission was granted a moment ago but publishing failed: do not stay in a paid
        // call that cannot hear the astrologer.
        this.room = null;
        this.wanted = false;
        void room.disconnect().catch(() => undefined);
        d({ type: "failed", failure: "mic", mic: micFailure(e) });
        return;
      }
      d({ type: "playback", canPlay: room.canPlayAudio() });
    } finally {
      if (gen === this.generation) this.busy = false;
    }
  }

  private events(gen: number): AudioRoomEvents {
    const current = () => gen === this.generation;
    const d = this.deps.dispatch;
    return {
      onDisconnected: (reason) => {
        if (!current()) return;
        this.room = null;
        if (!this.wanted || reason === "client") return;
        if (reason === "duplicate") {
          this.wanted = false;
          d({ type: "failed", failure: "duplicate" });
        } else if (reason === "room_closed") {
          // The server deletes the room when the session ends; the socket's `ended` follows.
          this.wanted = false;
          d({ type: "left" });
        } else {
          this.scheduleRetry();
        }
      },
      onReconnecting: () => current() && d({ type: "reconnecting" }),
      onReconnected: () => current() && d({ type: "connected" }),
      onPlayback: (canPlay) => current() && d({ type: "playback", canPlay }),
      onRemoteAudio: (count) => current() && d({ type: "remote_audio", count }),
      onMicError: (err) => current() && d({ type: "mic", mic: micFailure(err) }),
    };
  }

  private scheduleRetry(): void {
    if (!this.wanted) return;
    const max = this.deps.maxAttempts ?? 5;
    if (this.attempt >= max) {
      this.wanted = false;
      this.deps.dispatch({ type: "failed", failure: "connect_failed" });
      return;
    }
    this.deps.dispatch({ type: "reconnecting" });
    const delay = backoffMs(this.attempt, this.random);
    this.attempt += 1;
    this.clearTimer();
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, delay);
  }
}
