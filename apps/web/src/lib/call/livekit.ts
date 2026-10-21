import type { LiveKitAdapter, RoomLike } from "./media";

/**
 * The real LiveKit adapter. livekit-client is loaded only when the user joins a call, so the
 * profile and chat pages never download it.
 */
export async function loadLiveKit(): Promise<LiveKitAdapter> {
  const lk = await import("livekit-client");
  return {
    createRoom: () =>
      new lk.Room({
        adaptiveStream: false,
        dynacast: false,
        // Leave the room when the tab closes, so the server sees us go at once.
        disconnectOnPageLeave: true,
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      }) as unknown as RoomLike,
    events: {
      trackSubscribed: lk.RoomEvent.TrackSubscribed,
      trackUnsubscribed: lk.RoomEvent.TrackUnsubscribed,
      reconnecting: lk.RoomEvent.Reconnecting,
      signalReconnecting: lk.RoomEvent.SignalReconnecting,
      reconnected: lk.RoomEvent.Reconnected,
      disconnected: lk.RoomEvent.Disconnected,
      audioPlaybackChanged: lk.RoomEvent.AudioPlaybackStatusChanged,
    },
    preflightMic: async () => {
      const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
      if (!md?.getUserMedia) {
        // Insecure context or a very old browser.
        throw Object.assign(new Error("no mediaDevices"), { name: "NotSupportedError" });
      }
      const stream = await md.getUserMedia({ audio: true, video: false });
      for (const track of stream.getTracks()) track.stop();
    },
    supportsOutputSelection: () => lk.supportsAudioOutputSelection(),
    listOutputs: async () =>
      (await lk.Room.getLocalDevices("audiooutput", false))
        .filter((d) => d.deviceId)
        .map((d) => ({ deviceId: d.deviceId, label: d.label })),
  };
}
