"use client";

import type { Locale } from "@astro/shared";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { dateTimeIst, formatPaise } from "@/lib/marketplace/format";
import { blockedKey } from "@/lib/revenue/ai";
import type { AiQuestion } from "@/lib/revenue/types";
import { AiLabel } from "./AiLabel";

/** One question and its answer, always labelled AI, always with the human hand-off. */
export function QuestionItem({ q, locale }: { q: AiQuestion; locale: Locale }) {
  const t = useTranslations("revenue.ai");
  return (
    <article className="space-y-3 rounded-md border border-border p-4" data-status={q.status}>
      <div>
        <p className="text-sm text-muted">
          {t("you")} · {dateTimeIst(q.created_at, locale)}
        </p>
        <p className="mt-1 whitespace-pre-wrap">{q.text}</p>
      </div>
      <div className="space-y-2 border-t border-border pt-3">
        <AiLabel locale={locale} />
        {q.status === "queued" && <p aria-live="polite">{t("thinking")}</p>}
        {q.status === "answered" && q.answer && (
          <p className="whitespace-pre-wrap leading-relaxed">{q.answer}</p>
        )}
        {q.status === "blocked" && (
          <p role="note" data-testid="ai-blocked">
            {t(`blocked.${blockedKey(q.blocked_reason)}`)}
          </p>
        )}
        {q.status === "failed" && <p role="note">{t("failed")}</p>}
        {(q.status === "blocked" || q.status === "failed") &&
          !q.refunded &&
          q.price_paise === 0 && <p className="text-sm text-muted">{t("notCharged")}</p>}
        {q.refunded && (
          <p className="text-sm text-muted">
            {t("refunded", { amount: formatPaise(q.price_paise, locale) })}
          </p>
        )}
        <p className="text-sm text-muted">{t("aiNote")}</p>
        <Link
          href="/astrologers"
          className="inline-block text-sm font-medium text-accent underline"
        >
          {t("handoff")}
        </Link>
      </div>
    </article>
  );
}
