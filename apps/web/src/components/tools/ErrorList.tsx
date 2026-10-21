"use client";

import { useTranslations } from "next-intl";

/** Announces form and engine errors to screen readers. */
export function ErrorList({ errors }: { errors: string[] }) {
  const te = useTranslations("toolsUi.errors");
  return (
    <div aria-live="polite" role="status" className="text-sm text-danger">
      {errors.map((e) => (
        <p key={e}>{te.has(e) ? te(e) : te("generic")}</p>
      ))}
    </div>
  );
}

export function SubmitButton({ pending }: { pending: boolean }) {
  const t = useTranslations("toolsUi.form");
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-sm bg-primary px-5 py-2 font-medium text-primary-fg disabled:opacity-60"
    >
      {pending ? t("submitting") : t("submit")}
    </button>
  );
}

export function PrivacyNote() {
  const t = useTranslations("toolsUi.form");
  return <p className="text-xs text-muted">{t("privacy")}</p>;
}
