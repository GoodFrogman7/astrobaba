"use client";

import { istToday, type Locale } from "@astro/shared";
import { useLocale, useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import { Dialog } from "@/components/billing/Dialog";
import { useWallet } from "@/components/billing/useWallet";
import { SignIn } from "@/components/marketplace/SignIn";
import { call, refreshWallet } from "@/lib/billing/client";
import { IntentKeys } from "@/lib/billing/idempotency";
import { REMEDY_NOTE_MAX } from "@/lib/revenue/config";
import { leadBody, validateLead, type LeadError } from "@/lib/revenue/remedies";
import type { RemedyLead } from "@/lib/revenue/types";

/**
 * "Request via partner" on /remedies: a plain button in the static page; the form opens in a
 * dialog. Signing in is required because the partner contacts the user on their phone.
 */
export function RemedyRequest({ remedyId, name }: { remedyId: string; name: string }) {
  const t = useTranslations("revenue.remedies");
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-sm border border-primary px-4 py-2 text-sm font-medium text-primary"
      >
        {t("request")}
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("dialogTitle", { name })}
        closeLabel={t("close")}
      >
        <SignedInLead remedyId={remedyId} />
      </Dialog>
    </>
  );
}

function SignedInLead({ remedyId }: { remedyId: string }) {
  const t = useTranslations("revenue.remedies");
  const wallet = useWallet();
  if (wallet === undefined) return <p className="text-muted">{t("loading")}</p>;
  if (wallet === null) return <p role="alert">{t("errors.generic")}</p>;
  if (!wallet.signed_in)
    return (
      <div className="space-y-3">
        <p>{t("signIn")}</p>
        <SignIn onSignedIn={() => void refreshWallet()} />
      </div>
    );
  return <LeadForm remedyId={remedyId} />;
}

type Send =
  | { step: "idle" }
  | { step: "sending" }
  | { step: "sent" }
  | { step: "invalid"; errors: LeadError[] }
  | { step: "error"; key: "network" | "generic" | "signin" | "consentRequired" };

/** The partner request form. Consent is a required checkbox that starts unticked. */
export function LeadForm({ remedyId }: { remedyId: string }) {
  const t = useTranslations("revenue.remedies");
  const locale = useLocale() as Locale;
  const id = useId();
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const [consent, setConsent] = useState(false);
  const [send, setSend] = useState<Send>({ step: "idle" });
  const keys = useRef(new IntentKeys());
  const today = istToday();
  const errors = send.step === "invalid" ? send.errors : [];

  async function submit() {
    const input = { remedyId, preferredDate: date, language: locale, note, consent };
    const invalid = validateLead(input, today);
    if (invalid.length) return setSend({ step: "invalid", errors: invalid });
    setSend({ step: "sending" });
    const body = leadBody(input);
    const r = await call<RemedyLead>("/api/remedies/leads", {
      method: "POST",
      body,
      idempotencyKey: keys.current.for(JSON.stringify(body)),
    });
    if (r.ok) {
      keys.current.done();
      return setSend({ step: "sent" });
    }
    if (r.status !== 0) keys.current.done();
    if (r.status === 401) return setSend({ step: "error", key: "signin" });
    // 403: the age/terms consent step was closed (docs/api/trust.md §1); 422: the partner
    // consent box (docs/api/revenue.md §4).
    if (r.status === 403 && r.error.code === "consent_required")
      return setSend({ step: "error", key: "consentRequired" });
    if (r.error.code === "consent_required")
      return setSend({ step: "invalid", errors: ["consent"] });
    setSend({ step: "error", key: r.status === 0 ? "network" : "generic" });
  }

  if (send.step === "sent")
    return (
      <p role="status" className="font-medium" data-testid="lead-sent">
        {t("sent")}
      </p>
    );

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="space-y-4"
    >
      <p className="text-sm">{t("howItWorks")}</p>
      <div>
        <label htmlFor={`${id}-date`} className="block text-sm font-medium">
          {t("date")}
        </label>
        <input
          id={`${id}-date`}
          type="date"
          min={today}
          value={date}
          onChange={(e) => setDate(e.target.value)}
          aria-invalid={errors.includes("date") || undefined}
          className="mt-1 rounded-sm border border-border bg-surface px-3 py-2"
        />
        {errors.includes("date") && <p className="mt-1 text-sm text-danger">{t("errors.date")}</p>}
      </div>
      <div>
        <label htmlFor={`${id}-note`} className="block text-sm font-medium">
          {t("note")}
        </label>
        <textarea
          id={`${id}-note`}
          rows={3}
          maxLength={REMEDY_NOTE_MAX}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          aria-describedby={`${id}-note-hint`}
          className="mt-1 w-full rounded-sm border border-border bg-surface px-3 py-2"
        />
        <p id={`${id}-note-hint`} className="mt-1 text-sm text-muted tabular-nums">
          {t("noteHint", { count: Array.from(note).length, max: REMEDY_NOTE_MAX })}
        </p>
      </div>
      <div>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="consent"
            required
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            aria-invalid={errors.includes("consent") || undefined}
            className="mt-1"
            data-testid="lead-consent"
          />
          <span>{t("consent")}</span>
        </label>
        {errors.includes("consent") && (
          <p role="alert" className="mt-1 text-sm text-danger">
            {t("errors.consent")}
          </p>
        )}
      </div>
      <p className="text-sm text-muted">{t("noSale")}</p>
      <button
        type="submit"
        disabled={send.step === "sending"}
        className="rounded-sm bg-primary px-5 py-2 font-medium text-primary-fg disabled:opacity-60"
      >
        {t("send")}
      </button>
      <div aria-live="polite" className="text-sm">
        {send.step === "sending" && <p>{t("sending")}</p>}
        {send.step === "error" && <p role="alert">{t(`errors.${send.key}`)}</p>}
      </div>
    </form>
  );
}
