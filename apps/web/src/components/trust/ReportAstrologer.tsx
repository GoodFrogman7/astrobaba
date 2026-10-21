"use client";

import { ASTROLOGER_REPORT_REASONS, type AstrologerReportReason } from "@astro/shared";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import { Dialog } from "@/components/billing/Dialog";
import { SignIn } from "@/components/marketplace/SignIn";
import { call } from "@/lib/billing/client";
import { IntentKeys } from "@/lib/billing/idempotency";
import {
  REPORT_NOTE_MAX,
  submitReport,
  type ReportError,
  type ReportOutcome,
} from "@/lib/trust/report";

type Status = { step: "idle" } | { step: "sending" } | { step: "done"; outcome: ReportOutcome };

/**
 * "Report this astrologer" (docs/api/trust.md §4): a reason from the contract's list, an
 * optional note of at most 500 characters, one Idempotency-Key per report. Used on the
 * consultation page (during or after) and on the astrologer's profile.
 */
export function ReportAstrologer({
  astrologerId,
  sessionId,
  name,
}: {
  astrologerId: string;
  sessionId?: string | null;
  name: string;
}) {
  const t = useTranslations("trust.report");
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="py-1 text-sm text-muted underline"
        data-testid="report-open"
      >
        {t("open")}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={t("title", { name })}>
        <ReportForm astrologerId={astrologerId} sessionId={sessionId ?? null} />
      </Dialog>
    </>
  );
}

export function ReportForm({
  astrologerId,
  sessionId = null,
  initial = { step: "idle" },
}: {
  astrologerId: string;
  sessionId?: string | null;
  /** For tests: the state to render. */
  initial?: Status;
}) {
  const t = useTranslations("trust.report");
  const id = useId();
  const [reason, setReason] = useState<AstrologerReportReason | "">("");
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<Status>(initial);
  const keys = useRef(new IntentKeys());
  const count = Array.from(note.trim()).length;
  const outcome = status.step === "done" ? status.outcome : null;
  const errors: ReportError[] = outcome?.kind === "invalid" ? outcome.errors : [];

  async function send() {
    setStatus({ step: "sending" });
    const r = await submitReport({ astrologerId, sessionId, reason, note }, keys.current, call);
    setStatus({ step: "done", outcome: r });
  }

  if (outcome?.kind === "sent")
    return (
      <p role="status" className="font-medium" data-testid="report-sent">
        {t("sent")}
      </p>
    );

  return (
    <div className="space-y-4">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        className="space-y-4"
        data-testid="report-form"
      >
        <p className="text-sm">{t("intro")}</p>
        <fieldset aria-invalid={errors.includes("reason") || undefined}>
          <legend className="font-medium">{t("reason")}</legend>
          <div className="mt-2 grid gap-2">
            {ASTROLOGER_REPORT_REASONS.map((r) => (
              <label key={r} className="flex items-start gap-2">
                <input
                  type="radio"
                  name={`${id}-reason`}
                  value={r}
                  required
                  checked={reason === r}
                  onChange={() => setReason(r)}
                  className="mt-1"
                />
                <span>{t(`reasons.${r}`)}</span>
              </label>
            ))}
          </div>
          {errors.includes("reason") && (
            <p className="mt-1 text-sm text-danger">{t("errors.reason")}</p>
          )}
        </fieldset>
        <div>
          <label htmlFor={`${id}-note`} className="block font-medium">
            {t("note")}
          </label>
          <textarea
            id={`${id}-note`}
            value={note}
            rows={3}
            maxLength={REPORT_NOTE_MAX}
            onChange={(e) => setNote(e.target.value)}
            aria-describedby={`${id}-hint`}
            aria-invalid={errors.includes("note") || undefined}
            className="mt-1 w-full rounded-sm border border-border bg-bg px-3 py-2"
          />
          <p id={`${id}-hint`} className="text-sm text-muted">
            {errors.includes("note")
              ? t("errors.note", { max: REPORT_NOTE_MAX })
              : t("noteHint", { max: REPORT_NOTE_MAX })}{" "}
            <span className="tabular-nums">{t("chars", { count, max: REPORT_NOTE_MAX })}</span>
          </p>
        </div>
        <button
          type="submit"
          disabled={status.step === "sending"}
          className="rounded-sm bg-primary px-4 py-2 font-medium text-primary-fg disabled:opacity-60"
        >
          {status.step === "sending" ? t("sending") : t("submit")}
        </button>
        <div aria-live="polite" className="text-sm">
          {outcome?.kind === "duplicate" && <p role="alert">{t("errors.duplicate")}</p>}
          {outcome?.kind === "error" && <p role="alert">{t(`errors.${outcome.key}`)}</p>}
          {outcome?.kind === "signin" && <p role="alert">{t("errors.signin")}</p>}
        </div>
      </form>
      {outcome?.kind === "signin" && (
        <SignIn source="report-astrologer" onSignedIn={() => void send()} />
      )}
    </div>
  );
}
