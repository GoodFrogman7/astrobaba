import type { AudioRoom, AudioRoomEvents, DropReason } from "./audio";

/**
 * LiveKit adapter for CallAudio (browser only; livekit-client is loaded on demand so the console
 * and chat pages never download it). Audio only: no camera, no data publishing, remote audio
 * tracks are attached as hidden <audio> elements inside `sink`.
 */
export async function createLiveKitRoom(
  events: AudioRoomEvents,
  sink: () => HTMLElement | null,
): Promise<AudioRoom> {
  const { Room, RoomEvent, Track, DisconnectReason } = await import("livekit-client");
  const room = new Room({
    adaptiveStream: false,
    dynacast: false,
    audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const attached = new Map<string, HTMLMediaElement[]>();
  const count = () => events.onRemoteAudio(attached.size);

  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind !== Track.Kind.Audio) return;
    const el = track.attach();
    el.setAttribute("data-call-audio", "remote");
    sink()?.appendChild(el);
    attached.set(track.sid ?? String(attached.size), [el]);
    count();
  });
  room.on(RoomEvent.TrackUnsubscribed, (track) => {
    if (track.kind !== Track.Kind.Audio) return;
    for (const el of track.detach()) el.remove();
    attached.delete(track.sid ?? "");
    count();
  });
  room.on(RoomEvent.AudioPlaybackStatusChanged, (playing) => events.onPlayback(playing));
  room.on(RoomEvent.Reconnecting, () => events.onReconnecting());
  room.on(RoomEvent.Reconnected, () => events.onReconnected());
  room.on(RoomEvent.MediaDevicesError, (err) => events.onMicError(err));
  room.on(RoomEvent.Disconnected, (reason) => {
    for (const els of attached.values()) for (const el of els) el.remove();
    attached.clear();
    count();
    let why: DropReason = "other";
    if (reason === DisconnectReason.CLIENT_INITIATED) why = "client";
    else if (reason === DisconnectReason.DUPLICATE_IDENTITY) why = "duplicate";
    else if (
      reason === DisconnectReason.ROOM_DELETED ||
      reason === DisconnectReason.ROOM_CLOSED ||
      reason === DisconnectReason.PARTICIPANT_REMOVED
    ) {
      why = "room_closed";
    }
    events.onDisconnected(why);
  });

  return {
    connect: (url, token) => room.connect(url, token, { autoSubscribe: true }),
    setMicrophone: async (enabled) => {
      await room.localParticipant.setMicrophoneEnabled(enabled);
    },
    startAudio: () => room.startAudio(),
    canPlayAudio: () => room.canPlaybackAudio,
    disconnect: () => room.disconnect(),
  };
}

/** Ask for the microphone once, then release it (LiveKit opens its own track after joining). */
export async function requestMicrophone(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw Object.assign(new Error("no mediaDevices"), { name: "NotFoundError" });
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  for (const t of stream.getTracks()) t.stop();
}
