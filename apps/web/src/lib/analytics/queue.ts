import {
  ANALYTICS_SCHEMA_VERSION,
  validateEvent,
  type EventName,
  type Locale,
} from "@astro/shared";
import { MAX_BATCH } from "./config";

/** What the browser sends to /api/e; the route adds anonymous_id, user_id and schema_version. */
export interface ClientEvent {
  event: EventName;
  ts: string;
  locale: Locale;
  properties: Record<string, string | number | boolean>;
}

/** Stand-in for the HttpOnly `aid` the browser never sees, only so the envelope validates. */
const PLACEHOLDER_ID = "browser-side-check";

/** The shared closed-schema validator, run in the browser so a bad event never leaves it. */
export function isValidClientEvent(e: ClientEvent): boolean {
  return validateEvent({
    ...e,
    anonymous_id: PLACEHOLDER_ID,
    user_id: null,
    schema_version: ANALYTICS_SCHEMA_VERSION,
  }).ok;
}

export type Transport = (body: string) => void;

/**
 * Events wait here until the next flush (every 5 s, when the tab is hidden, or when a full batch
 * is ready). Each send carries at most `maxBatch` events. The queue is bounded: when the
 * transport is never reached, the oldest events are dropped rather than growing without limit.
 */
export class EventQueue {
  private items: ClientEvent[] = [];

  constructor(
    private readonly send: Transport,
    private readonly maxBatch = MAX_BATCH,
    private readonly maxQueued = 10 * MAX_BATCH,
  ) {}

  get size(): number {
    return this.items.length;
  }

  /** Queue a valid event; false (and nothing queued) when the schema rejects it. */
  push(e: ClientEvent): boolean {
    if (!isValidClientEvent(e)) return false;
    if (this.items.length >= this.maxQueued) this.items.shift();
    this.items.push(e);
    if (this.items.length >= this.maxBatch) this.flush();
    return true;
  }

  /** Send everything queued, in batches; returns the number of sends. */
  flush(): number {
    let sends = 0;
    while (this.items.length) {
      const batch = this.items.splice(0, this.maxBatch);
      try {
        this.send(JSON.stringify({ events: batch }));
      } catch {
        /* analytics never breaks the page */
      }
      sends++;
    }
    return sends;
  }

  clear(): void {
    this.items = [];
  }
}

/** navigator.sendBeacon (a text/plain body, so no preflight), else fetch with keepalive. */
export function beaconTransport(url: string): Transport {
  return (body) => {
    try {
      if (typeof navigator !== "undefined" && navigator.sendBeacon?.(url, body)) return;
    } catch {
      /* fall through to fetch */
    }
    void fetch(url, {
      method: "POST",
      body,
      keepalive: true,
      credentials: "same-origin",
      headers: { "content-type": "text/plain;charset=UTF-8" },
    }).catch(() => undefined);
  };
}
