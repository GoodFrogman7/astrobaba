"use client";

import type { ChatMessage, ParticipantRole } from "@astro/shared";
import { useLocale, useTranslations } from "next-intl";
import type { PendingMessage } from "@/lib/chat/reducer";

function timeIst(iso: string, locale: "en" | "hi"): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(locale === "hi" ? "hi-IN" : "en-IN", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  }).format(d);
}

/**
 * Messages in server order, then our own messages still on their way. Not a live region itself
 * (that would read out our own messages); ChatRoom announces the other side's messages.
 */
export function MessageList({
  messages,
  pending,
  role,
  otherName,
  onRetry,
}: {
  messages: ChatMessage[];
  pending: PendingMessage[];
  role: ParticipantRole;
  otherName: string;
  onRetry?: (clientId: string) => void;
}) {
  const t = useTranslations("billing.chat");
  const locale = useLocale() as "en" | "hi";
  const count = messages.length + pending.length;

  // System messages carry a code (`session_started`, `low_balance`, `session_ended:<reason>`).
  const systemText = (text: string) => {
    const code = text.split(":")[0];
    return t.has(`systemCodes.${code}`) ? t(`systemCodes.${code}`) : t("system");
  };

  return (
    <ol aria-label={t("messages")} className="space-y-3" data-testid="messages">
      {count === 0 && <li className="text-center text-sm text-muted">{t("noMessages")}</li>}
      {messages.map((m) => {
        if (m.sender === "system")
          return (
            <li key={m.seq} className="text-center text-xs text-muted">
              {systemText(m.text)}
            </li>
          );
        const mine = m.sender === role;
        return (
          <li key={m.seq} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[85%] rounded-md px-3 py-2 ${
                mine ? "bg-primary text-primary-fg" : "border border-border bg-surface"
              }`}
            >
              <p className="sr-only">{mine ? t("you") : otherName}</p>
              <p className="whitespace-pre-wrap break-words">{m.text}</p>
              <p className="mt-1 text-right text-xs opacity-80">{timeIst(m.sent_at, locale)}</p>
            </div>
          </li>
        );
      })}
      {pending.map((p) => (
        <li key={p.client_id} className="flex justify-end">
          <div className="max-w-[85%] rounded-md bg-primary px-3 py-2 text-primary-fg opacity-75">
            <p className="sr-only">{t("you")}</p>
            <p className="whitespace-pre-wrap break-words">{p.text}</p>
            <p className="mt-1 text-right text-xs">
              {p.status === "sending" ? (
                t("sending")
              ) : (
                <>
                  {t("notSent")}{" "}
                  {onRetry && (
                    <button
                      type="button"
                      onClick={() => onRetry(p.client_id)}
                      className="underline"
                    >
                      {t("retrySend")}
                    </button>
                  )}
                </>
              )}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}
