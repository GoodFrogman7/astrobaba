"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { call } from "@/lib/billing/client";
import { TAXONOMY } from "@/lib/marketplace/taxonomy";

/** Review after a completed chat or call (one per session; the API enforces it). */
export function ReviewForm({
  sessionId,
  onDone,
  heading,
}: {
  sessionId: string;
  onDone: () => void;
  heading?: string;
}) {
  const t = useTranslations("billing.chat.review");
  const [rating, setRating] = useState(0);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const id = useId();
  const err = (c: string) => (t.has(`errors.${c}`) ? t(`errors.${c}`) : t("errors.generic"));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (rating < 1) return setMsg({ text: err("invalid_rating"), ok: false });
    setBusy(true);
    const r = await call<{ status?: string }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/review`,
      { method: "POST", body: { rating, text } },
    );
    setBusy(false);
    if (r.ok) {
      setMsg({ text: r.data.status === "flagged" ? t("held") : t("thanks"), ok: true });
      onDone();
    } else setMsg({ text: err(r.error.code), ok: false });
  }

  if (msg?.ok) return <p role="status">{msg.text}</p>;
  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="space-y-3 rounded-md border border-border bg-surface p-5"
    >
      <h3 className="text-lg font-semibold">{heading ?? t("heading")}</h3>
      <fieldset>
        <legend className="text-sm font-medium">{t("rating")}</legend>
        <div className="mt-1 flex flex-wrap gap-3">
          {[1, 2, 3, 4, 5].map((n) => (
            <label key={n} className="inline-flex items-center gap-1 py-1 text-sm">
              <input
                type="radio"
                name={`${id}-rating`}
                value={n}
                checked={rating === n}
                onChange={() => setRating(n)}
              />
              {t("star", { count: n })}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="block text-sm">
        {t("text")}
        <textarea
          value={text}
          maxLength={TAXONOMY.review.max_text_chars}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          className="mt-1 block w-full rounded-sm border border-border bg-surface p-2"
        />
      </label>
      <p role="alert" className="text-sm" style={{ color: "var(--color-danger)" }}>
        {msg && !msg.ok ? msg.text : ""}
      </p>
      <button
        type="submit"
        disabled={busy}
        className="rounded-sm bg-primary px-4 py-2 font-medium text-primary-fg disabled:opacity-60"
      >
        {busy ? t("sending") : t("submit")}
      </button>
    </form>
  );
}
