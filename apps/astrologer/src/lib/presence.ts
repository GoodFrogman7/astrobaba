/**
 * Presence heartbeat: while the astrologer is online and this tab is open, POST
 * `/v1/astrologer/me/presence {status: "online"}` every 60 s. The server keeps the key for 120 s,
 * so one missed beat is tolerated and a closed tab drops to offline within two minutes.
 */

export const HEARTBEAT_MS = 60_000;

export type PresenceStatus = "online" | "offline";

export interface HeartbeatDeps {
  send(status: PresenceStatus): Promise<{ ok: boolean; status: number }>;
  onBeat?(ok: boolean, status: number): void;
  timers?: {
    setInterval(fn: () => void, ms: number): unknown;
    clearInterval(id: unknown): void;
  };
  intervalMs?: number;
}

export interface Heartbeat {
  /** Go online now and keep beating. Resolves with the first response. */
  goOnline(): Promise<{ ok: boolean; status: number }>;
  /** Stop beating and tell the server we are offline. */
  goOffline(): Promise<{ ok: boolean; status: number }>;
  /** Stop beating without telling the server (unmount; the TTL expires the key). */
  dispose(): void;
  readonly running: boolean;
}

export function createHeartbeat(deps: HeartbeatDeps): Heartbeat {
  const timers = deps.timers ?? {
    setInterval: (fn: () => void, ms: number) => globalThis.setInterval(fn, ms),
    clearInterval: (id: unknown) =>
      globalThis.clearInterval(id as ReturnType<typeof globalThis.setInterval>),
  };
  let timer: unknown = null;

  const stop = () => {
    if (timer !== null) timers.clearInterval(timer);
    timer = null;
  };

  const beat = async () => {
    try {
      const r = await deps.send("online");
      deps.onBeat?.(r.ok, r.status);
      return r;
    } catch {
      deps.onBeat?.(false, 0);
      return { ok: false, status: 0 };
    }
  };

  return {
    async goOnline() {
      stop();
      const first = await beat();
      // Not allowed (not public, signed out): do not keep hammering the API.
      if (!first.ok && first.status >= 400 && first.status < 500) return first;
      timer = timers.setInterval(() => void beat(), deps.intervalMs ?? HEARTBEAT_MS);
      return first;
    },
    async goOffline() {
      stop();
      try {
        return await deps.send("offline");
      } catch {
        return { ok: false, status: 0 };
      }
    },
    dispose: stop,
    get running() {
      return timer !== null;
    },
  };
}

/** Ids of `requested` sessions not seen before, to announce new requests once. */
export function newRequestIds(
  seen: ReadonlySet<string>,
  items: { id: string; status: string }[],
): string[] {
  return items.filter((s) => s.status === "requested" && !seen.has(s.id)).map((s) => s.id);
}
