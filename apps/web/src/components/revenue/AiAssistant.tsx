"use client";

import type { Locale } from "@astro/shared";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useWallet } from "@/components/billing/useWallet";
import { SignIn } from "@/components/marketplace/SignIn";
import { Link, usePathname, useRouter } from "@/i18n/navigation";
import { call, refreshWallet } from "@/lib/billing/client";
import { ID_PATTERN } from "@/lib/revenue/ids";
import { IntentKeys } from "@/lib/billing/idempotency";
import { formatPaise, shortDate } from "@/lib/marketplace/format";
import { askQuestion, questionPending, type AskOutcome } from "@/lib/revenue/ai";
import { AI_QUESTION } from "@/lib/revenue/config";
import type { AiConversation } from "@/lib/revenue/types";
import { QuestionItem } from "./AiQuestionItem";
import { useKundlis } from "./useKundlis";

const POLL_MS = 3000;

/**
 * The AI assistant (docs/api/revenue.md §3): pick a saved kundli, ask paid questions, read
 * answers. Every answer carries the AI label and a hand-off to human astrologers. The open
 * conversation id is kept in the URL (?c=) so a reload finds it again.
 */
export function AiAssistant() {
  const t = useTranslations("revenue.ai");
  const locale = useLocale() as Locale;
  const wallet = useWallet();
  const signedIn = wallet?.signed_in === true;
  const kundlis = useKundlis(signedIn);
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const fromUrl = params.get("c");
  const conversationId = fromUrl && ID_PATTERN.test(fromUrl) ? fromUrl : null;
  const [kundliId, setKundliId] = useState("");
  const [starting, setStarting] = useState<"idle" | "busy" | "error">("idle");

  if (wallet === undefined) return <p className="text-muted">{t("loading")}</p>;
  if (wallet === null) return <p role="alert">{t("errors.generic")}</p>;
  if (!wallet.signed_in)
    return (
      <div className="space-y-3">
        <p>{t("signIn")}</p>
        <SignIn onSignedIn={() => void refreshWallet()} />
      </div>
    );

  async function start() {
    if (!kundliId) return;
    setStarting("busy");
    const r = await call<{ id: string }>("/api/ai/conversations", {
      method: "POST",
      body: { kundli_id: kundliId },
    });
    if (!r.ok) return setStarting("error");
    setStarting("idle");
    router.replace(`${pathname}?c=${encodeURIComponent(r.data.id)}`);
  }

  if (conversationId)
    return (
      <Conversation
        id={conversationId}
        balance={wallet.wallet.total_paise}
        onNew={() => router.replace(pathname)}
        locale={locale}
      />
    );

  return (
    <section
      aria-labelledby="ai-start"
      className="space-y-4 rounded-md border border-border bg-surface p-5"
    >
      <h2 id="ai-start" className="text-lg font-semibold">
        {t("pickHeading")}
      </h2>
      {kundlis === undefined && <p className="text-muted">{t("kundlisLoading")}</p>}
      {kundlis === null && <p role="alert">{t("errors.kundlis")}</p>}
      {kundlis && kundlis.length === 0 && (
        <p>
          {t("noKundlis")}{" "}
          <Link href="/kundli" className="text-accent underline">
            {t("createKundli")}
          </Link>
        </p>
      )}
      {kundlis && kundlis.length > 0 && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
          className="space-y-3"
        >
          <fieldset>
            <legend className="text-sm font-medium">{t("pickLegend")}</legend>
            <div className="mt-2 grid gap-2">
              {kundlis.map((k) => (
                <label key={k.id} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="ai-kundli"
                    value={k.id}
                    checked={kundliId === k.id}
                    onChange={() => setKundliId(k.id)}
                  />
                  {k.name} · {shortDate(`${k.birth.date}T12:00:00Z`, locale)}
                </label>
              ))}
            </div>
          </fieldset>
          <button
            type="submit"
            disabled={!kundliId || starting === "busy"}
            className="rounded-sm bg-primary px-5 py-2 font-medium text-primary-fg disabled:opacity-60"
          >
            {t("start")}
          </button>
          <p aria-live="polite" className="text-sm">
            {starting === "error" ? t("errors.start") : ""}
          </p>
        </form>
      )}
    </section>
  );
}

function Conversation({
  id,
  balance,
  onNew,
  locale,
}: {
  id: string;
  balance: number;
  onNew: () => void;
  locale: Locale;
}) {
  const t = useTranslations("revenue.ai");
  const fmt = (p: number) => formatPaise(p, locale);
  const [conv, setConv] = useState<AiConversation | null | "missing" | "error">(null);
  const [text, setText] = useState("");
  const [asking, setAsking] = useState(false);
  const [outcome, setOutcome] = useState<AskOutcome | null>(null);
  const keys = useRef(new IntentKeys());
  const inputId = useId();

  const load = useCallback(async () => {
    const r = await call<AiConversation>(`/api/ai/conversations/${id}`);
    if (r.ok) setConv({ ...r.data, questions: r.data.questions ?? [] });
    else setConv(r.status === 404 ? "missing" : "error");
    return r.ok ? r.data : null;
  }, [id]);

  const pending = typeof conv === "object" && conv !== null && conv.questions.some(questionPending);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => {
      void load().then((c) => {
        if (c && !c.questions.some(questionPending)) void refreshWallet();
      });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [pending, load]);

  async function ask() {
    setAsking(true);
    setOutcome(null);
    const o = await askQuestion(id, text, { keys: keys.current, balance });
    setAsking(false);
    setOutcome(o);
    if (o.kind === "queued") {
      setText("");
      void refreshWallet();
      setConv((c) =>
        typeof c === "object" && c !== null ? { ...c, questions: [...c.questions, o.question] } : c,
      );
    }
  }

  if (conv === null) return <p className="text-muted">{t("loading")}</p>;
  if (conv === "missing" || conv === "error")
    return (
      <div role="alert" className="space-y-3">
        <p>{conv === "missing" ? t("errors.missing") : t("errors.generic")}</p>
        <button
          type="button"
          onClick={onNew}
          className="rounded-sm border border-border px-4 py-2 text-sm"
        >
          {t("newConversation")}
        </button>
      </div>
    );

  const count = Array.from(text.trim()).length;
  const over = count > AI_QUESTION.maxChars;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {conv.kundli?.label || conv.kundli?.name
            ? t("about", { name: String(conv.kundli.label ?? conv.kundli.name) })
            : null}
        </p>
        <button
          type="button"
          onClick={onNew}
          className="rounded-sm border border-border px-3 py-1.5 text-sm"
        >
          {t("newConversation")}
        </button>
      </div>

      {conv.questions.length === 0 ? (
        <p className="text-muted">{t("noQuestions")}</p>
      ) : (
        <ol className="space-y-4" aria-label={t("questions")}>
          {conv.questions.map((q) => (
            <li key={q.id}>
              <QuestionItem q={q} locale={locale} />
            </li>
          ))}
        </ol>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
        className="space-y-2 rounded-md border border-border bg-surface p-4"
      >
        <label htmlFor={inputId} className="block font-medium">
          {t("askLabel")}
        </label>
        <p className="text-sm" data-testid="ai-price">
          {t("price", { amount: fmt(AI_QUESTION.pricePaise) })}
        </p>
        <textarea
          id={inputId}
          value={text}
          rows={3}
          onChange={(e) => setText(e.target.value)}
          aria-describedby={`${inputId}-count`}
          aria-invalid={over || undefined}
          className="w-full rounded-sm border border-border bg-bg px-3 py-2"
        />
        <p id={`${inputId}-count`} className="text-sm text-muted tabular-nums">
          {t("chars", { count, max: AI_QUESTION.maxChars })}
        </p>
        <button
          type="submit"
          disabled={asking || count === 0 || over}
          className="rounded-sm bg-primary px-5 py-2 font-medium text-primary-fg disabled:opacity-60"
        >
          {t("ask", { amount: fmt(AI_QUESTION.pricePaise) })}
        </button>
        <div aria-live="polite" className="text-sm">
          {asking && <p>{t("sending")}</p>}
          {outcome?.kind === "invalid" && (
            <p role="alert">{t(`errors.${outcome.error}`, { max: AI_QUESTION.maxChars })}</p>
          )}
          {outcome?.kind === "message" && <p role="alert">{t(`errors.${outcome.key}`)}</p>}
          {outcome?.kind === "signin" && <p role="alert">{t("signIn")}</p>}
          {outcome?.kind === "insufficient" && (
            <div role="alert" className="space-y-1">
              <p>
                {t("insufficient", {
                  required: fmt(outcome.required),
                  available: fmt(outcome.available),
                })}
              </p>
              <Link
                href={`/wallet?amount=${outcome.suggest}`}
                className="font-medium text-accent underline"
              >
                {t("addMoney", { amount: fmt(outcome.suggest) })}
              </Link>
            </div>
          )}
        </div>
      </form>
    </div>
  );
}
