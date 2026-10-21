"use client";

import { DISCLAIMER, type SessionView } from "@astro/shared";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Dialog } from "@/components/billing/Dialog";
import { CallRoom } from "@/components/call/CallRoom";
import { SignIn } from "@/components/marketplace/SignIn";
import { Link } from "@/i18n/navigation";
import { BILLING } from "@/lib/billing/config";
import type { ConnStatus } from "@/lib/chat/connection";
import { elapsedSeconds, isTerminal, typingVisible, type ChatState } from "@/lib/chat/reducer";
import { clock, formatPaise } from "@/lib/marketplace/format";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { ReviewForm } from "./ReviewForm";
import { useChat, type EventTap } from "./useChat";

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * /chat/[sessionId]: waiting room, live chat (or a voice call, `kind: "call"`) with a human
 * astrologer, then the summary. Both kinds share the control socket from `useChat`.
 */
export function ChatRoom({ sessionId }: { sessionId: string }) {
  const t = useTranslations("billing.chat");
  const locale = useLocale() as "en" | "hi";
  const tapRef: EventTap = useRef(null);
  const chat = useChat(sessionId, tapRef);
  const { state, load } = chat;

  if (load === "loading") return <p className="text-muted">{t("loading")}</p>;
  if (load === "signed_out")
    return (
      <div className="space-y-3">
        <p>{t("signIn")}</p>
        <SignIn onSignedIn={() => void chat.reload()} />
      </div>
    );
  if (load === "not_found") return <p>{t("notFound")}</p>;
  if (load === "error" || !state.session)
    return (
      <div className="space-y-3" role="alert">
        <p>{t("error")}</p>
        <button
          type="button"
          onClick={() => void chat.reload()}
          className="rounded-sm border border-border px-4 py-2 text-sm"
        >
          {t("retry")}
        </button>
      </div>
    );

  const s = state.session;
  if (s.kind === "call") return <CallRoom chat={chat} session={s} tapRef={tapRef} />;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        {t("human", { name: s.astrologer.display_name })} {DISCLAIMER[locale]}
      </p>
      {s.status === "active" ? (
        <ActiveChat chat={chat} session={s} />
      ) : isTerminal(s.status) ? (
        <Ended session={s} state={state} onReviewed={() => void chat.reload()} />
      ) : (
        <Waiting session={s} onCancel={() => chat.act("cancel")} conn={chat.conn} />
      )}
    </div>
  );
}

export function ConnBanner({ conn, onUseHere }: { conn: ConnStatus; onUseHere: () => void }) {
  const t = useTranslations("billing.chat.conn");
  if (conn === "open" || conn === "closed") return null;
  return (
    <div role="status" className="rounded-sm border border-border bg-surface px-3 py-2 text-sm">
      {t(conn)}{" "}
      {conn === "replaced" && (
        <button type="button" onClick={onUseHere} className="font-medium underline">
          {t("useHere")}
        </button>
      )}
    </div>
  );
}

export function Waiting({
  session: s,
  onCancel,
  conn,
}: {
  session: SessionView;
  onCancel: () => Promise<boolean>;
  conn: ConnStatus;
}) {
  const t = useTranslations("billing.chat");
  const tc = useTranslations("billing.call");
  const isCall = s.kind === "call";
  const name = s.astrologer.display_name;
  return (
    <section
      aria-labelledby="waiting"
      className="space-y-3 rounded-md border border-border bg-surface p-5"
    >
      <div aria-live="polite" className="space-y-2">
        <h2 id="waiting" className="text-lg font-semibold">
          {s.status === "queued" && s.queue
            ? t("queued", { position: s.queue.position, name })
            : s.status === "accepted"
              ? t("accepted", { name })
              : (isCall ? tc : t)("requested", { name, minutes: BILLING.requestTimeoutMinutes })}
        </h2>
        {s.status === "queued" && s.queue && (
          <p>
            {s.queue.eta_minutes !== null ? t("eta", { minutes: s.queue.eta_minutes }) : t("noEta")}
          </p>
        )}
        <p className="text-sm text-muted">{(isCall ? tc : t)("notCharged")}</p>
      </div>
      {conn === "forbidden" && <p role="alert">{t("conn.forbidden")}</p>}
      <CancelButton label={t("cancel")} onCancel={onCancel} />
    </section>
  );
}

export function CancelButton({
  label,
  onCancel,
}: {
  label: string;
  onCancel: () => Promise<boolean>;
}) {
  const t = useTranslations("billing.chat");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setFailed(!(await onCancel()));
          setBusy(false);
        }}
        className="rounded-sm border border-border px-4 py-2 text-sm"
      >
        {label}
      </button>
      {failed && <p role="alert">{t("cancelError")}</p>}
    </>
  );
}

/** Paid sessions: minutes the balance still covers, and whether to warn about it. */
export function balanceWarning(s: SessionView, state: ChatState) {
  const minutesLeft = s.minutes_left ?? state.lowBalanceMinutes;
  const low =
    !s.is_free &&
    (state.lowBalanceMinutes !== null ||
      (minutesLeft !== null && minutesLeft <= BILLING.lowBalanceWarningMinutes));
  return { minutesLeft, low };
}

export function LowBalance({ text }: { text: string }) {
  const t = useTranslations("billing.chat");
  return (
    <div role="status" className="rounded-sm border border-border bg-surface px-3 py-2 text-sm">
      {text}{" "}
      <Link
        href="/wallet"
        target="_blank"
        rel="noopener"
        className="font-medium text-accent underline"
      >
        {t("rechargeNewTab")}
      </Link>
    </div>
  );
}

/** Confirm before ending; on failure the dialog stays open and says so. */
export function EndDialog({
  ns,
  open,
  onClose,
  onEnd,
}: {
  ns: "billing.chat" | "billing.call";
  open: boolean;
  onClose: () => void;
  onEnd: () => Promise<boolean>;
}) {
  const t = useTranslations(ns);
  const [failed, setFailed] = useState(false);
  return (
    <Dialog open={open} onClose={onClose} title={t("endTitle")} closeLabel={t("keep")}>
      <p>{t("endBody")}</p>
      {failed && <p role="alert">{t("endError")}</p>}
      <button
        type="button"
        onClick={async () => {
          const ok = await onEnd();
          setFailed(!ok);
          if (ok) onClose();
        }}
        className="mr-2 rounded-sm px-4 py-2 text-sm font-medium text-primary-fg"
        style={{ background: "var(--color-danger)" }}
      >
        {t("endConfirm")}
      </button>
    </Dialog>
  );
}

function ActiveChat({
  chat,
  session: s,
}: {
  chat: ReturnType<typeof useChat>;
  session: SessionView;
}) {
  const t = useTranslations("billing.chat");
  const locale = useLocale() as "en" | "hi";
  const now = useNow(1000);
  const { state } = chat;
  const [confirm, setConfirm] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const name = s.astrologer.display_name;
  const count = state.messages.length + state.pending.length;

  useEffect(() => {
    input.current?.focus();
  }, []);
  // Keep the newest message in view inside the scroll box (not the whole page).
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [count]);

  const { minutesLeft, low } = balanceWarning(s, state);
  const errorKey = state.lastError
    ? t.has(`errors.${state.lastError}`)
      ? `errors.${state.lastError}`
      : "errors.generic"
    : null;
  const announce = state.announce;

  return (
    <section aria-label={t("title")} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface p-3">
        <div>
          <p className="font-semibold">{name}</p>
          <p className="text-sm text-muted">
            {s.is_free && s.free_minutes !== null
              ? t("free", { minutes: s.free_minutes })
              : t("price", { price: formatPaise(s.price_per_min_paise, locale) })}
            {!s.is_free && minutesLeft !== null && (
              <> · {t("minutesLeft", { minutes: minutesLeft })}</>
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <p className="text-sm">
            <span className="text-muted">{t("elapsed")} </span>
            <span className="font-mono tabular-nums" data-testid="elapsed">
              {clock(elapsedSeconds(s, now, state.serverOffsetMs))}
            </span>
          </p>
          <button
            type="button"
            onClick={() => setConfirm(true)}
            className="rounded-sm border px-3 py-1.5 text-sm font-medium"
            style={{ borderColor: "var(--color-danger)", color: "var(--color-danger)" }}
          >
            {t("end")}
          </button>
        </div>
      </div>

      <ConnBanner conn={chat.conn} onUseHere={chat.reconnect} />

      {low && <LowBalance text={t("lowBalance", { minutes: minutesLeft ?? 0 })} />}

      <div
        ref={box}
        className="max-h-[60vh] min-h-64 overflow-y-auto rounded-md border border-border p-3"
      >
        <MessageList
          messages={state.messages}
          pending={state.pending}
          role={s.role}
          otherName={name}
          onRetry={chat.retry}
        />
      </div>
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {announce && announce.sender !== "system"
          ? t("newMessage", { name, text: announce.text })
          : ""}
      </div>
      <p className="h-5 text-sm text-muted">
        {typingVisible(state, now) ? t("typing", { name }) : ""}
      </p>
      {errorKey && (
        <p role="alert" className="text-sm" style={{ color: "var(--color-danger)" }}>
          {t(errorKey)}
        </p>
      )}
      <Composer
        ref={input}
        disabled={chat.conn === "forbidden"}
        onSend={chat.send}
        onTyping={chat.typing}
      />

      <EndDialog
        ns="billing.chat"
        open={confirm}
        onClose={() => setConfirm(false)}
        onEnd={() => chat.act("end")}
      />
    </section>
  );
}

export function Ended({
  session: s,
  state,
  onReviewed,
}: {
  session: SessionView;
  state: ChatState;
  onReviewed: () => void;
}) {
  const t = useTranslations("billing.chat");
  const tc = useTranslations("billing.call");
  const isCall = s.kind === "call";
  // Wording that names the kind ("Chat ended" / "Call ended"); the rest is shared.
  const tk = isCall ? tc : t;
  const locale = useLocale() as "en" | "hi";
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const reason = s.end_reason ?? "unknown";
  const charged = s.billed_minutes > 0;
  return (
    <div className="space-y-6">
      <section
        aria-labelledby="ended"
        className="space-y-2 rounded-md border border-border bg-surface p-5"
      >
        <h2 id="ended" ref={heading} tabIndex={-1} className="text-lg font-semibold">
          {s.status === "cancelled" ? t("ended.cancelledTitle") : tk("ended.title")}
        </h2>
        <p>{tk(`ended.reasons.${reason}`)}</p>
        {s.started_at && s.ended_at && (
          <p className="text-sm">
            {tk("ended.duration", { time: clock(elapsedSeconds(s, 0, state.serverOffsetMs)) })}
          </p>
        )}
        <p className="font-medium" data-testid="billed">
          {!charged
            ? t("ended.notCharged")
            : s.is_free
              ? tk("ended.freeBilled", { minutes: s.billed_minutes })
              : t("ended.billed", {
                  minutes: s.billed_minutes,
                  amount: formatPaise(s.billed_paise, locale),
                })}
        </p>
        {charged && !s.is_free && <p className="text-sm text-muted">{t("ended.refundNote")}</p>}
        <p className="flex flex-wrap gap-x-4 text-sm">
          <Link href="/wallet" className="text-accent underline">
            {t("ended.wallet")}
          </Link>
          <Link href={`/astrologers/${s.astrologer.slug}`} className="text-accent underline">
            {t("ended.again", { name: s.astrologer.display_name })}
          </Link>
        </p>
      </section>
      {s.can_review && (
        <ReviewForm
          sessionId={s.id}
          onDone={onReviewed}
          heading={isCall ? tc("review.heading") : undefined}
        />
      )}
      {state.messages.length > 0 && (
        <div className="rounded-md border border-border p-3">
          <MessageList
            messages={state.messages}
            pending={[]}
            role={s.role}
            otherName={s.astrologer.display_name}
          />
        </div>
      )}
    </div>
  );
}
