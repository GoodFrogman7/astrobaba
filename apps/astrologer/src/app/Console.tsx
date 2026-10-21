"use client";

import type { AvailabilitySlot, SessionView } from "@astro/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { activeSlot } from "@/lib/availability";
import { formatRate, formatWaiting, titleWithBadge } from "@/lib/format";
import { createHeartbeat, newRequestIds, type Heartbeat } from "@/lib/presence";

const POLL_ONLINE_MS = 3000;
const POLL_OFFLINE_MS = 30_000;
const PRESENCE_KEY = "ap_console_presence";

type Presence = "offline" | "online" | "switching";

function remembered(): boolean {
  try {
    return window.sessionStorage.getItem(PRESENCE_KEY) === "online";
  } catch {
    return false;
  }
}

function remember(online: boolean) {
  try {
    if (online) window.sessionStorage.setItem(PRESENCE_KEY, "online");
    else window.sessionStorage.removeItem(PRESENCE_KEY);
  } catch {
    /* storage blocked: the toggle simply starts offline next time */
  }
}

async function postJson(url: string, body: unknown = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
  return { ok: res.ok, status: res.status, data };
}

const ACTION_ERRORS: Record<string, string> = {
  invalid_transition: "This request is no longer waiting (the client may have cancelled).",
  session_not_found: "This request is no longer available.",
  api_unavailable: "The service is unreachable. Try again in a moment.",
};

/** "chat" or "call" in plain words, for labels and announcements. */
function kindWord(s: Pick<SessionView, "kind">): "chat" | "call" {
  return s.kind === "call" ? "call" : "chat";
}

export function Console({ slots = [] }: { slots?: AvailabilitySlot[] }) {
  const router = useRouter();
  const [presence, setPresence] = useState<Presence>("offline");
  const [presenceError, setPresenceError] = useState<string | null>(null);
  const [beatWarning, setBeatWarning] = useState(false);
  const [items, setItems] = useState<SessionView[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDecline, setConfirmDecline] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [reminderHidden, setReminderHidden] = useState<string | null>(null);
  const heartbeat = useRef<Heartbeat | null>(null);
  const seen = useRef<Set<string> | null>(null);
  const baseTitle = useRef<string | null>(null);

  const signedOut = useCallback(() => {
    router.replace("/login");
    router.refresh();
  }, [router]);

  const goOnline = useCallback(async () => {
    setPresence("switching");
    setPresenceError(null);
    const r = await heartbeat.current!.goOnline();
    if (r.status === 401) return signedOut();
    if (!r.ok) {
      setPresence("offline");
      remember(false);
      setPresenceError(
        r.status === 403 || r.status === 404 || r.status === 409
          ? "You can't go online right now: your profile is not public or chat is turned off. Contact support if this is unexpected."
          : "Could not go online. Check your connection and try again.",
      );
      return;
    }
    setPresence("online");
    remember(true);
  }, [signedOut]);

  const goOffline = useCallback(async () => {
    setPresence("switching");
    setPresenceError(null);
    const r = await heartbeat.current!.goOffline();
    if (r.status === 401) return signedOut();
    setPresence("offline");
    remember(false);
    setBeatWarning(false);
    if (!r.ok) {
      setPresenceError(
        "You are offline here, but the server did not confirm it. You will drop off the list within 2 minutes.",
      );
    }
  }, [signedOut]);

  // Resume "online" after a reload of the same tab; stop beating when the page goes away.
  useEffect(() => {
    const hb = createHeartbeat({
      send: (status) => postJson("/api/presence", { status }),
      onBeat: (ok, status) => {
        if (status === 401) return signedOut();
        setBeatWarning(!ok);
      },
    });
    heartbeat.current = hb;
    // Deferred so the effect body itself never sets state.
    const resume = remembered() ? setTimeout(() => void goOnline(), 0) : null;
    return () => {
      if (resume !== null) clearTimeout(resume);
      hb.dispose();
    };
  }, [goOnline, signedOut]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions/incoming", { cache: "no-store" });
      if (res.status === 401) return signedOut();
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { items: SessionView[] };
      setLoadError(false);
      setItems(body.items);
      const first = seen.current === null;
      const fresh = newRequestIds(seen.current ?? new Set(), body.items);
      seen.current = new Set(body.items.map((s) => s.id));
      if (!first && fresh.length > 0) {
        const s = body.items.find((x) => x.id === fresh[0]);
        setAnnouncement(
          fresh.length === 1 && s
            ? `New ${kindWord(s)} request from ${s.client_label} (${s.is_free ? "free" : formatRate(s.price_per_min_paise)}).`
            : `${fresh.length} new requests.`,
        );
      }
    } catch {
      setLoadError(true);
    }
  }, [signedOut]);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const id = setInterval(
      () => void load(),
      presence === "online" ? POLL_ONLINE_MS : POLL_OFFLINE_MS,
    );
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [load, presence]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const requested = (items ?? []).filter((s) => s.status === "requested").length;
  useEffect(() => {
    if (baseTitle.current === null) baseTitle.current = document.title;
    document.title = titleWithBadge(baseTitle.current, requested);
  }, [requested]);
  useEffect(() => {
    return () => {
      if (baseTitle.current !== null) document.title = baseTitle.current;
    };
  }, []);

  async function act(id: string, action: "accept" | "decline") {
    setBusyId(id);
    setActionError(null);
    try {
      const r = await postJson(`/api/sessions/${encodeURIComponent(id)}/${action}`);
      if (r.status === 401) return signedOut();
      if (!r.ok) {
        setActionError(
          ACTION_ERRORS[r.data.code ?? ""] ?? r.data.message ?? "That did not work. Try again.",
        );
        await load();
        return;
      }
      if (action === "accept") router.push(`/sessions/${encodeURIComponent(id)}`);
      else await load();
    } catch {
      setActionError("Network error. Try again.");
    } finally {
      setBusyId(null);
      setConfirmDecline(null);
    }
  }

  const online = presence === "online";
  // The schedule never changes presence (portal.md §2.1); it only prompts, gently.
  const slotNow = activeSlot(slots, now);
  const slotKey = slotNow ? `${slotNow.weekday}-${slotNow.start}-${slotNow.end}` : null;
  const showReminder = slotNow !== null && presence === "offline" && reminderHidden !== slotKey;

  return (
    <div className="mt-6 space-y-8">
      <section
        aria-labelledby="presence-h"
        className="rounded-md border border-border bg-surface p-5"
      >
        <h2 id="presence-h" className="text-lg font-semibold">
          Availability
        </h2>
        <div className="mt-3 flex flex-wrap items-center gap-4">
          <button
            type="button"
            aria-pressed={online}
            disabled={presence === "switching"}
            onClick={() => void (online ? goOffline() : goOnline())}
            className={`rounded-full px-5 py-2 font-medium disabled:opacity-60 ${
              online ? "bg-success text-primary-fg" : "border border-border"
            }`}
          >
            {presence === "switching" ? "Updating…" : online ? "Online" : "Offline"}
          </button>
          <span className="text-sm" role="status" aria-live="polite">
            {online
              ? "You are online. New requests can reach you."
              : "You are offline. No new requests will reach you."}
          </span>
        </div>
        <p className="mt-3 text-sm text-muted">
          Going offline stops new requests straight away; a chat already in progress continues.
          While online, keep this tab open: if it closes, you drop to offline within 2 minutes. When
          you are in a chat or call, clients see you as busy. Your{" "}
          <Link href="/schedule" className="underline">
            weekly schedule
          </Link>{" "}
          is shown on your profile but does not switch you online.
        </p>
        {showReminder && slotNow && (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-md border border-border bg-bg px-4 py-3 text-sm">
            <p className="flex-1">
              Your schedule says you are available now ({slotNow.start}–{slotNow.end} IST), but you
              are offline. Go online when you are ready to take requests.
            </p>
            <button
              type="button"
              onClick={() => setReminderHidden(slotKey)}
              className="text-muted underline"
            >
              Not now
            </button>
          </div>
        )}
        {beatWarning && online && (
          <p className="mt-2 text-sm text-danger">
            Could not refresh your online status. Retrying every minute.
          </p>
        )}
        {presenceError && <p className="mt-2 text-sm text-danger">{presenceError}</p>}
      </section>

      <section aria-labelledby="incoming-h">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="incoming-h" className="text-lg font-semibold">
            Requests {requested > 0 && <span className="text-accent">({requested} waiting)</span>}
          </h2>
          <span className="text-xs text-muted">
            Updates every {online ? "3 seconds" : "30 seconds"}
          </span>
        </div>
        <div role="status" aria-live="polite" className="mt-2">
          {announcement && (
            <p className="flex items-center justify-between gap-3 rounded-md border-2 border-accent bg-surface px-4 py-3 font-medium">
              <span>{announcement}</span>
              <button
                type="button"
                onClick={() => setAnnouncement(null)}
                className="text-sm text-muted underline"
              >
                Dismiss
              </button>
            </p>
          )}
        </div>
        {actionError && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {actionError}
          </p>
        )}
        {loadError && (
          <p className="mt-2 text-sm text-danger">Could not load requests. Retrying…</p>
        )}
        {items === null ? (
          <p className="mt-4 text-muted">Loading…</p>
        ) : items.length === 0 ? (
          <p className="mt-4 text-muted">
            No requests right now.{!online && " Go online to receive requests."}
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {items.map((s) => (
              <li key={s.id} className="rounded-md border border-border bg-surface p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      <span
                        className={`rounded-sm px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${
                          s.kind === "call"
                            ? "bg-accent text-accent-fg"
                            : "border border-border text-fg"
                        }`}
                      >
                        {s.kind === "call" ? "Voice call" : "Chat"}
                      </span>
                      <span>{s.client_label}</span>
                    </p>
                    <p className="text-sm text-muted">
                      {s.is_free
                        ? `Free session${s.free_minutes ? ` (up to ${s.free_minutes} min)` : ""}`
                        : `Paid · ${formatRate(s.price_per_min_paise)}`}
                      {" · "}
                      {s.status === "queued" && s.queue
                        ? `In queue, position ${s.queue.position} · waiting ${formatWaiting(s.created_at, now)}`
                        : s.status === "requested"
                          ? `Waiting ${formatWaiting(s.created_at, now)}`
                          : s.status === "accepted"
                            ? "Accepted, waiting for the client to join"
                            : s.kind === "call"
                              ? "Call in progress"
                              : "Chat in progress"}
                    </p>
                    {s.kind === "call" && s.status === "requested" && (
                      <p className="text-xs text-muted">
                        Accepting opens the call room. Allow microphone access when your browser
                        asks.
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {(s.status === "accepted" || s.status === "active") && (
                      <Link
                        href={`/sessions/${encodeURIComponent(s.id)}`}
                        className="rounded-sm bg-primary px-3 py-1.5 text-sm text-primary-fg"
                      >
                        {s.kind === "call" ? "Open call" : "Open chat"}
                      </Link>
                    )}
                    {s.status === "requested" && (
                      <button
                        type="button"
                        disabled={busyId !== null}
                        onClick={() => void act(s.id, "accept")}
                        className="rounded-sm bg-primary px-3 py-1.5 text-sm text-primary-fg disabled:opacity-60"
                      >
                        {s.kind === "call" ? "Accept call" : "Accept chat"}
                      </button>
                    )}
                    {(s.status === "requested" || s.status === "queued") &&
                      (confirmDecline === s.id ? (
                        <>
                          <button
                            type="button"
                            disabled={busyId !== null}
                            onClick={() => void act(s.id, "decline")}
                            className="rounded-sm bg-danger px-3 py-1.5 text-sm text-primary-fg disabled:opacity-60"
                          >
                            Yes, decline
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDecline(null)}
                            className="rounded-sm border border-border px-3 py-1.5 text-sm"
                          >
                            Keep
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          disabled={busyId !== null}
                          onClick={() => setConfirmDecline(s.id)}
                          className="rounded-sm border border-border px-3 py-1.5 text-sm disabled:opacity-60"
                        >
                          Decline
                        </button>
                      ))}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
