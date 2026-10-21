"use client";

import type { Locale } from "@astro/shared";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { dateTimeIst, formatPaise } from "@/lib/marketplace/format";
import { blockedKey } from "@/lib/revenue/ai";
import type { AiQuestion } from "@/lib/revenue/types";
import { CrisisPanel } from "@/components/trust/CrisisPanel";
import { AiLabel } from "./AiLabel";

/**
 * One question and its answer, always labelled AI, with the human hand-off. A question blocked
 * for self-harm shows the crisis resources instead of the hand-off: no consultation offer at
 * that moment (docs/api/trust.md §3).
 */
export function QuestionItem({ q, locale }: { q: AiQuestion; locale: Locale }) {
  const t = useTranslations("revenue.ai");
  const selfHarm = q.status === "blocked" && blockedKey(q.blocked_reason) === "selfHarm";
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
        {selfHarm && <CrisisPanel focus={false} />}
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
        {!selfHarm && (
          <Link
            href="/astrologers"
            className="inline-block text-sm font-medium text-accent underline"
          >
            {t("handoff")}
          </Link>
        )}
      </div>
    </article>
  );
}
