"use client";

import { useTranslations } from "next-intl";
import { useId } from "react";

/** Full-name form for name numerology. */
export function NameField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useTranslations("toolsUi.form");
  const id = useId();
  return (
    <div className="rounded-md border border-border bg-surface p-4">
      <label htmlFor={id} className="block text-sm font-medium">
        {t("fullName")}
      </label>
      <input
        id={id}
        type="text"
        required
        maxLength={60}
        autoComplete="name"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={`${id}-hint`}
        className="mt-1 w-full rounded-sm border border-border bg-surface px-3 py-2"
      />
      <p id={`${id}-hint`} className="mt-1 text-xs text-muted">
        {t("numerologyHint")}
      </p>
    </div>
  );
}

/** Date-of-birth form for mulank and destiny number. */
export function DobField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useTranslations("toolsUi.form");
  const id = useId();
  return (
    <div className="rounded-md border border-border bg-surface p-4">
      <label htmlFor={id} className="block text-sm font-medium">
        {t("date")}
      </label>
      <input
        id={id}
        type="date"
        required
        min="1800-01-02"
        max="2399-12-30"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-sm border border-border bg-surface px-3 py-2"
      />
    </div>
  );
}
