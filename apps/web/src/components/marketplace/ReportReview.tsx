"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

/** Report a review to moderators (signed-in users; the API keeps it visible until reviewed). */
export function ReportReview({ id }: { id: string }) {
  const t = useTranslations("market.profile");
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState("");
  async function send() {
    const res = await fetch(`/api/reviews/${encodeURIComponent(id)}/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason }),
    }).catch(() => null);
    if (res?.ok) {
      setMsg(t("reported"));
      setOpen(false);
    } else setMsg(res?.status === 401 ? t("reportSignIn") : t("reportError"));
  }
  return (
    <span className="text-xs">
      {!open && !msg && (
        <button type="button" onClick={() => setOpen(true)} className="py-1 text-muted underline">
          {t("report")}
        </button>
      )}
      {open && (
        <span className="mt-2 flex w-full flex-col gap-2">
          <label>
            {t("reportReason")}
            <textarea
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1 block w-full rounded-sm border border-border bg-surface p-2"
            />
          </label>
          <button
            type="button"
            disabled={!reason.trim()}
            onClick={() => void send()}
            className="self-start rounded-sm border border-border px-3 py-1"
          >
            {t("reportSend")}
          </button>
        </span>
      )}
      <span aria-live="polite">{msg}</span>
    </span>
  );
}
