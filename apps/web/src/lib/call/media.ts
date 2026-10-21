import type { CallToken } from "@astro/shared";
import { micIssue, type AudioOutput, type CallAction } from "./state";

/**
 * Our side of a call's LiveKit room, audio only. It talks to LiveKit through a small adapter
 * (`livekit.ts` wraps livekit-client) so the join/leave logic is unit-tested with a fake room.
 *
 * Order matters for billing fairness: the microphone is checked *before* we enter the room. The
 * server makes a call `active` (minute 1 charged) once both participants have joined, so a user
 * whose microphone is blocked must never appear in the room.
 */
export interface MediaElementLike {
  remove(): void;
}

export interface RemoteTrackLike {
  kind: string;
  attach(): MediaElementLike;
  detach(): MediaElementLike[];
}

export interface RoomLike {
  on(event: string, listener: (...args: never[]) => void): unknown;
  connect(url: string, token: string, opts?: { autoSubscribe?: boolean }): Promise<void>;
  disconnect(stopTracks?: boolean): Promise<void>;
  localParticipant: { setMicrophoneEnabled(enabled: boolean): Promise<unknown> };
  readonly canPlaybackAudio: boolean;
  startAudio(): Promise<void>;
  switchActiveDevice(kind: MediaDeviceKind, deviceId: string): Promise<boolean>;
}

/** The livekit-client RoomEvent values we listen to. */
export interface RoomEventNames {
  trackSubscribed: string;
  trackUnsubscribed: string;
  reconnecting: string;
  signalReconnecting: string;
  reconnected: string;
  disconnected: string;
  audioPlaybackChanged: string;
}

export interface LiveKitAdapter {
  createRoom(): RoomLike;
  events: RoomEventNames;
  /** Ask for the microphone (permission prompt) and release it again; throws like getUserMedia. */
  preflightMic(): Promise<void>;
  supportsOutputSelection(): boolean;
  listOutputs(): Promise<AudioOutput[]>;
}

export type TokenResult = { ok: true; data: CallToken } | { ok: false; code: string };

export interface CallMediaOptions {
  load(): Promise<LiveKitAdapter>;
  getToken(): Promise<TokenResult>;
  dispatch(a: CallAction): void;
  /** Put a remote <audio> element on the page (a hidden node). */
  mountAudio(el: MediaElementLike): void;
}

export class CallMedia {
  private room: RoomLike | null = null;
  private generation = 0;
  private elements = new Set<MediaElementLike>();

  constructor(private readonly o: CallMediaOptions) {}

  get inRoom(): boolean {
    return this.room !== null;
  }

  /** Check the microphone, get a token, enter the room, publish the microphone. */
  async join(): Promise<void> {
    this.release();
    const gen = ++this.generation;
    const stale = () => gen !== this.generation;
    this.o.dispatch({ type: "join_start" });

    let lk: LiveKitAdapter;
    try {
      lk = await this.o.load();
    } catch {
      if (!stale()) this.o.dispatch({ type: "join_failed", code: "load_failed" });
      return;
    }
    if (stale()) return;

    try {
      await lk.preflightMic();
    } catch (e) {
      if (!stale()) this.o.dispatch({ type: "mic_failed", issue: micIssue(e) });
      return;
    }
    if (stale()) return;

    const token = await this.o
      .getToken()
      .catch((): TokenResult => ({ ok: false, code: "network_error" }));
    if (stale()) return;
    if (!token.ok) {
      this.o.dispatch({ type: "join_failed", code: token.code });
      return;
    }

    this.o.dispatch({ type: "connecting" });
    const room = lk.createRoom();
    this.room = room;
    this.wire(room, lk.events);
    try {
      await room.connect(token.data.url, token.data.token, { autoSubscribe: true });
    } catch {
      if (stale()) return;
      this.release();
      this.o.dispatch({ type: "join_failed", code: "connect_failed" });
      return;
    }
    if (stale()) return;

    try {
      await room.localParticipant.setMicrophoneEnabled(true);
    } catch (e) {
      if (stale()) return;
      // Never stay in the room without a microphone: leave before the call can start.
      this.release();
      this.o.dispatch({ type: "mic_failed", issue: micIssue(e) });
      return;
    }
    if (stale()) return;
    this.o.dispatch({ type: "connected", audioBlocked: !room.canPlaybackAudio });

    if (lk.supportsOutputSelection()) {
      const outputs = await lk.listOutputs().catch(() => []);
      if (!stale() && outputs.length > 1)
        this.o.dispatch({ type: "outputs", outputs, active: null });
    }
  }

  /** Leave the room now (session over, page left, user ended). Safe to call any time. */
  leave(): void {
    this.generation += 1;
    this.release();
    this.o.dispatch({ type: "left" });
  }

  async setMuted(muted: boolean): Promise<void> {
    const room = this.room;
    if (!room) return;
    try {
      await room.localParticipant.setMicrophoneEnabled(!muted);
      if (this.room === room) this.o.dispatch({ type: "muted", muted });
    } catch (e) {
      if (this.room === room && !muted) this.o.dispatch({ type: "mic_failed", issue: micIssue(e) });
    }
  }

  /** Must run inside a click/tap handler: browsers allow audio playback only after a gesture. */
  async startAudio(): Promise<void> {
    const room = this.room;
    if (!room) return;
    await room.startAudio().catch(() => undefined);
    if (this.room === room)
      this.o.dispatch({ type: "audio_blocked", blocked: !room.canPlaybackAudio });
  }

  async setOutput(deviceId: string, outputs: AudioOutput[]): Promise<void> {
    const room = this.room;
    if (!room) return;
    const ok = await room.switchActiveDevice("audiooutput", deviceId).catch(() => false);
    if (ok && this.room === room) this.o.dispatch({ type: "outputs", outputs, active: deviceId });
  }

  private wire(room: RoomLike, ev: RoomEventNames) {
    const mine = () => this.room === room;
    room.on(ev.trackSubscribed, (track: RemoteTrackLike) => {
      if (!mine() || track.kind !== "audio") return;
      const el = track.attach();
      this.elements.add(el);
      this.o.mountAudio(el);
    });
    room.on(ev.trackUnsubscribed, (track: RemoteTrackLike) => {
      for (const el of track.detach()) {
        el.remove();
        this.elements.delete(el);
      }
    });
    const reconnecting = () => mine() && this.o.dispatch({ type: "reconnecting" });
    room.on(ev.reconnecting, reconnecting);
    room.on(ev.signalReconnecting, reconnecting);
    room.on(ev.reconnected, () => mine() && this.o.dispatch({ type: "reconnected" }));
    room.on(ev.audioPlaybackChanged, () => {
      if (mine()) this.o.dispatch({ type: "audio_blocked", blocked: !room.canPlaybackAudio });
    });
    room.on(ev.disconnected, () => {
      // Ours (leave/release) clears `this.room` first, so this is only an unexpected drop.
      if (!mine()) return;
      this.room = null;
      this.generation += 1;
      this.removeElements();
      this.o.dispatch({ type: "dropped" });
    });
  }

  private removeElements() {
    for (const el of this.elements) el.remove();
    this.elements.clear();
  }

  private release() {
    const room = this.room;
    this.room = null;
    this.removeElements();
    if (room) void room.disconnect(true).catch(() => undefined);
  }
}
