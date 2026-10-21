"use client";

import { DISCLAIMER, type ParticipantRole, type SessionView } from "@astro/shared";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Dialog } from "@/components/billing/Dialog";
import { ConnBanner, Ended, useNow, Waiting } from "@/components/chat/ChatRoom";
import type { EventTap, useChat } from "@/components/chat/useChat";
import { Link } from "@/i18n/navigation";
import { BILLING } from "@/lib/billing/config";
import { callScreen, joinedMap, type CallScreen, type CallState } from "@/lib/call/state";
import { elapsedSeconds } from "@/lib/chat/reducer";
import { clock, formatPaise } from "@/lib/marketplace/format";
import { useCallMedia } from "./useCallMedia";

type Chat = ReturnType<typeof useChat>;
type Media = ReturnType<typeof useCallMedia>;

const danger = { borderColor: "var(--color-danger)", color: "var(--color-danger)" };

/**
 * A voice call with a human astrologer (docs/api/portal.md §1). Waiting and the summary are the
 * chat's; in between: explain the microphone, join the LiveKit room on a tap, then the call.
 * The server alone decides when billing starts (`active` arrives on the control socket).
 */
export function CallRoom({
  chat,
  session: s,
  tapRef,
}: {
  chat: Chat;
  session: SessionView;
  tapRef: EventTap;
}) {
  const t = useTranslations("billing.call");
  const locale = useLocale() as "en" | "hi";
  const media = useCallMedia(s.id, chat, tapRef);
  const joined = joinedMap(s, chat.state.callJoined);
  const screen = callScreen(s, media.state, joined);
  const name = s.astrologer.display_name;
  const reload = chat.reload;

  // A token refused because the session moved on: show what it is now.
  const notJoinable = media.state.joinError === "session_not_joinable";
  useEffect(() => {
    if (notJoinable) void reload();
  }, [notJoinable, reload]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        {t("human", { name })} {DISCLAIMER[locale]}
      </p>
      {/* The astrologer's audio plays from here; it has no visible controls of its own. */}
      <div id={media.sinkId} hidden data-testid="call-audio" />
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {statusText(t, screen, media.state, joined, name)}
      </p>
      {screen === "waiting" ? (
        <Waiting session={s} onCancel={() => chat.act("cancel")} conn={chat.conn} />
      ) : screen === "ended" ? (
        <Ended session={s} state={chat.state} onReviewed={() => void reload()} />
      ) : screen === "join" || screen === "mic_blocked" || screen === "join_failed" ? (
        <JoinPanel chat={chat} session={s} media={media} screen={screen} />
      ) : (
        <CallPanel chat={chat} session={s} media={media} screen={screen} joined={joined} />
      )}
    </div>
  );
}

type T = ReturnType<typeof useTranslations<"billing.call">>;

/** One sentence for the screen-reader live region whenever the call's state changes. */
function statusText(
  t: T,
  screen: CallScreen,
  call: CallState,
  joined: Record<ParticipantRole, boolean>,
  name: string,
): string {
  switch (screen) {
    case "join":
      return call.media === "dropped" ? t("state.dropped") : t("mic.title", { name });
    case "mic_blocked":
      return t("mic.blockedTitle");
    case "join_failed":
      return t("join.title");
    case "connecting":
      return t("state.connecting");
    case "waiting_astrologer":
      return t("state.waitingAstrologer", { name });
    case "starting":
      return t("state.starting", { name });
    case "in_call":
      if (call.media === "reconnecting") return t("state.reconnecting");
      if (!joined.astrologer) return t("state.astrologerAway", { name });
      return t("state.inCall", { name });
    case "ended":
      return t("state.ended");
    default:
      return "";
  }
}

function CancelButton({ chat }: { chat: Chat }) {
  const t = useTranslations("billing.chat");
  const tc = useTranslations("billing.call");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setFailed(!(await chat.act("cancel")));
          setBusy(false);
        }}
        className="rounded-sm border border-border px-4 py-2 text-sm"
      >
        {tc("cancel")}
      </button>
      {failed && <p role="alert">{t("cancelError")}</p>}
    </>
  );
}

/** Before the room: what the microphone is for, then a tap to join (or to try again). */
function JoinPanel({
  chat,
  session: s,
  media,
  screen,
}: {
  chat: Chat;
  session: SessionView;
  media: Media;
  screen: "join" | "mic_blocked" | "join_failed";
}) {
  const t = useTranslations("billing.call");
  const heading = useRef<HTMLHeadingElement>(null);
  const name = s.astrologer.display_name;
  const { mic, joinError } = media.state;
  const dropped = media.state.media === "dropped";
  const active = s.status === "active";
  useEffect(() => {
    heading.current?.focus();
  }, [screen]);

  const title =
    screen === "mic_blocked"
      ? t("mic.blockedTitle")
      : screen === "join_failed"
        ? t("join.title")
        : dropped
          ? t("state.dropped")
          : active
            ? t("mic.rejoinTitle", { name })
            : t("mic.title", { name });
  const joinError_ = joinError && t.has(`join.${joinError}`) ? `join.${joinError}` : "join.failed";

  return (
    <section
      aria-labelledby="call-join"
      className="space-y-3 rounded-md border border-border bg-surface p-5"
    >
      <h2 id="call-join" ref={heading} tabIndex={-1} className="text-lg font-semibold">
        {title}
      </h2>
      {screen === "mic_blocked" && mic ? (
        <p role="alert">{t(`mic.issues.${mic}`)}</p>
      ) : screen === "join_failed" ? (
        <p role="alert">{t(joinError_)}</p>
      ) : (
        <p>{t("mic.body")}</p>
      )}
      <p className="text-sm text-muted">
        {active || dropped
          ? t("mic.rejoinBody", { seconds: BILLING.heartbeatGraceSeconds })
          : t("mic.timeout", { seconds: BILLING.joinTimeoutSeconds })}
      </p>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={media.join}
          disabled={chat.conn === "forbidden"}
          className="rounded-sm bg-primary px-4 py-2 font-medium text-primary-fg disabled:opacity-60"
        >
          {screen !== "join" ? t("retry") : active || dropped ? t("mic.rejoin") : t("mic.join")}
        </button>
        {s.status === "accepted" && <CancelButton chat={chat} />}
      </div>
      <ConnBanner conn={chat.conn} onUseHere={chat.reconnect} />
    </section>
  );
}

/** In the room: connecting, waiting for the astrologer's audio, then the call itself. */
function CallPanel({
  chat,
  session: s,
  media,
  screen,
  joined,
}: {
  chat: Chat;
  session: SessionView;
  media: Media;
  screen: "connecting" | "waiting_astrologer" | "starting" | "in_call";
  joined: Record<ParticipantRole, boolean>;
}) {
  const t = useTranslations("billing.call");
  const tchat = useTranslations("billing.chat");
  const locale = useLocale() as "en" | "hi";
  const now = useNow(1000);
  const { state } = chat;
  const call = media.state;
  const [confirm, setConfirm] = useState(false);
  const [endFailed, setEndFailed] = useState(false);
  const muteRef = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const name = s.astrologer.display_name;
  const inCall = screen === "in_call";

  useEffect(() => {
    if (inCall) muteRef.current?.focus();
    else heading.current?.focus();
  }, [inCall]);

  const minutesLeft = s.minutes_left ?? state.lowBalanceMinutes;
  const low =
    inCall &&
    !s.is_free &&
    (state.lowBalanceMinutes !== null ||
      (minutesLeft !== null && minutesLeft <= BILLING.lowBalanceWarningMinutes));
  const line =
    screen === "connecting"
      ? t("state.connecting")
      : screen === "waiting_astrologer"
        ? t("state.waitingAstrologer", { name })
        : screen === "starting"
          ? t("state.starting", { name })
          : call.media === "reconnecting"
            ? t("state.reconnecting")
            : !joined.astrologer
              ? t("state.astrologerAway", { name })
              : t("state.inCall", { name });

  return (
    <section aria-labelledby="call-panel" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface p-4">
        <div>
          <h2 id="call-panel" ref={heading} tabIndex={-1} className="font-semibold">
            {line}
          </h2>
          <p className="text-sm text-muted">
            {s.is_free && s.free_minutes !== null
              ? t("free", { minutes: s.free_minutes })
              : tchat("price", { price: formatPaise(s.price_per_min_paise, locale) })}
            {inCall && !s.is_free && minutesLeft !== null && (
              <> · {tchat("minutesLeft", { minutes: minutesLeft })}</>
            )}
          </p>
          {!inCall && <p className="mt-1 text-sm text-muted">{t("notChargedYet")}</p>}
        </div>
        {inCall && (
          <p className="text-sm">
            <span className="text-muted">{tchat("elapsed")} </span>
            <span className="font-mono tabular-nums" data-testid="elapsed">
              {clock(elapsedSeconds(s, now, state.serverOffsetMs))}
            </span>
          </p>
        )}
      </div>

      <ConnBanner conn={chat.conn} onUseHere={chat.reconnect} />

      {call.audioBlocked && (
        <div className="space-y-2 rounded-sm border border-border bg-surface px-3 py-3">
          <p>{t("audioBlocked")}</p>
          <button
            type="button"
            onClick={media.startAudio}
            className="rounded-sm bg-primary px-4 py-2 font-medium text-primary-fg"
          >
            {t("enableAudio")}
          </button>
        </div>
      )}

      {low && (
        <div role="status" className="rounded-sm border border-border bg-surface px-3 py-2 text-sm">
          {t("lowBalance", { minutes: minutesLeft ?? 0 })}{" "}
          <Link
            href="/wallet"
            target="_blank"
            rel="noopener"
            className="font-medium text-accent underline"
          >
            {tchat("rechargeNewTab")}
          </Link>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          ref={muteRef}
          type="button"
          aria-pressed={call.muted}
          disabled={screen === "connecting"}
          onClick={() => media.setMuted(!call.muted)}
          className="rounded-sm border border-border px-4 py-2 text-sm font-medium disabled:opacity-60"
        >
          {t("mute")}
        </button>
        {inCall ? (
          <button
            type="button"
            onClick={() => setConfirm(true)}
            className="rounded-sm border px-4 py-2 text-sm font-medium"
            style={danger}
          >
            {t("end")}
          </button>
        ) : (
          s.status === "accepted" && <CancelButton chat={chat} />
        )}
        {call.outputs.length > 1 && (
          <label className="flex items-center gap-2 text-sm">
            {t("speaker")}
            <select
              value={call.outputId ?? ""}
              onChange={(e) => e.target.value && media.setOutput(e.target.value)}
              className="rounded-sm border border-border bg-surface px-2 py-1.5"
            >
              <option value="">{t("speakerDefault")}</option>
              {call.outputs.map((o, i) => (
                <option key={o.deviceId} value={o.deviceId}>
                  {o.label || t("speakerN", { n: i + 1 })}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {call.muted && <p className="text-sm">{t("muted")}</p>}

      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={t("endTitle")}
        closeLabel={t("keep")}
      >
        <p>{t("endBody")}</p>
        {endFailed && <p role="alert">{t("endError")}</p>}
        <button
          type="button"
          onClick={async () => {
            const ok = await chat.act("end");
            setEndFailed(!ok);
            if (ok) setConfirm(false);
          }}
          className="mr-2 rounded-sm px-4 py-2 text-sm font-medium text-primary-fg"
          style={{ background: "var(--color-danger)" }}
        >
          {t("endConfirm")}
        </button>
      </Dialog>
    </section>
  );
}
