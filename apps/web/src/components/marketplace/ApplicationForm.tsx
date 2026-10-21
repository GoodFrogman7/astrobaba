"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import {
  MAX_PRICE_PAISE,
  MIN_PRICE_PAISE,
  validateApplication,
} from "@/lib/marketplace/application";
import { formatPaise } from "@/lib/marketplace/format";
import { TAXONOMY } from "@/lib/marketplace/taxonomy";
import type { ApplicationInput } from "@/lib/marketplace/types";

const field = "mt-1 w-full rounded-sm border border-border bg-surface px-3 py-2";
const INVITE_MAX = 64;

/** The invite code from an invite link (`?invite=CODE`, docs/api/growth.md §2.1), tidied the
 *  way people type it: upper case, no spaces or hyphens. Empty when absent. */
export function inviteFromSearch(search: string | URLSearchParams): string {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  return (params.get("invite") ?? "")
    .replace(/[\s-]+/g, "")
    .toUpperCase()
    .slice(0, INVITE_MAX);
}

/** The JSON body for the API: `invite_code` only when one was given. */
export function applicationBody(
  input: ApplicationInput,
  invite: string,
): ApplicationInput & { invite_code?: string } {
  const code = invite.trim();
  return code ? { ...input, invite_code: code.slice(0, INVITE_MAX) } : input;
}

/** Error keys (under market.apply.form.errors) for a failed submission. */
export function applicationErrors(status: number, body: { code?: string; fields?: string[] }) {
  if (body.fields?.length) return body.fields;
  if (status === 403 && body.code === "invite_required") return ["invite_required"];
  if (status === 422 && body.code === "invite_invalid") return ["invite_invalid"];
  if (body.code === "already_applied") return ["already_applied"];
  return ["generic"];
}

/** Astrologer application. All details go in the POST body to /api/astrologer/application. */
export function ApplicationForm({
  onDone,
  invite: initialInvite,
}: {
  onDone: () => void;
  /** Prefilled invite code; when omitted it is read from `?invite=` in the address. */
  invite?: string;
}) {
  const t = useTranslations("market.apply.form");
  const locale = useLocale() as "en" | "hi";
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // The form mounts only in the browser (ApplyGate shows it after loading the applicant), so
  // reading the address here cannot cause a hydration mismatch.
  const [invite, setInvite] = useState(
    () =>
      initialInvite ??
      (typeof window === "undefined" ? "" : inviteFromSearch(window.location.search)),
  );

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const input: ApplicationInput = {
      display_name: String(fd.get("display_name") ?? "").trim(),
      bio: String(fd.get("bio") ?? "").trim(),
      ...(String(fd.get("bio_hi") ?? "").trim() ? { bio_hi: String(fd.get("bio_hi")).trim() } : {}),
      skills: fd.getAll("skills").map(String),
      languages: fd.getAll("languages").map(String),
      gender: String(fd.get("gender") ?? ""),
      experience_years: Number(fd.get("experience_years")),
      requested_price_per_min_paise: Math.round(Number(fd.get("price_rupees")) * 100),
      accepts_terms: fd.get("accepts_terms") === "on" ? true : (false as unknown as true),
    };
    const local = validateApplication(input);
    setErrors(local);
    if (local.length) return;
    setBusy(true);
    try {
      const res = await fetch("/api/astrologer/application", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(applicationBody(input, invite)),
      });
      if (res.ok) return onDone();
      const body = (await res.json().catch(() => ({}))) as { code?: string; fields?: string[] };
      setErrors(applicationErrors(res.status, body));
    } catch {
      setErrors(["generic"]);
    } finally {
      setBusy(false);
    }
  }

  const err = (k: string) =>
    errors.includes(k) ? (
      <span className="mt-1 block text-sm" style={{ color: "var(--color-danger)" }}>
        {t(`errors.${k}`)}
      </span>
    ) : null;

  return (
    <form
      onSubmit={(e) => void submit(e)}
      noValidate
      className="max-w-2xl space-y-5 rounded-md border border-border bg-surface p-5"
    >
      <h2 className="text-lg font-semibold">{t("title")}</h2>
      <label className="block text-sm font-medium">
        {t("invite")}
        <input
          name="invite_code"
          value={invite}
          onChange={(e) => setInvite(e.currentTarget.value)}
          maxLength={INVITE_MAX}
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          aria-describedby="invite-hint"
          aria-invalid={errors.includes("invite_invalid") || errors.includes("invite_required")}
          className={`${field} font-mono uppercase`}
        />
        <span id="invite-hint" className="mt-1 block text-sm font-normal text-muted">
          {t("inviteHint")}
        </span>
      </label>
      <label className="block text-sm font-medium">
        {t("displayName")}
        <input
          name="display_name"
          required
          maxLength={60}
          className={field}
          aria-invalid={errors.includes("display_name")}
        />
        {err("display_name")}
      </label>
      <label className="block text-sm font-medium">
        {t("bio")}
        <textarea
          name="bio"
          required
          minLength={50}
          maxLength={2000}
          rows={5}
          className={field}
          aria-invalid={errors.includes("bio")}
        />
        {err("bio")}
      </label>
      <label className="block text-sm font-medium">
        {t("bioHi")}
        <textarea name="bio_hi" maxLength={2000} rows={4} lang="hi" className={field} />
        {err("bio_hi")}
      </label>
      <fieldset aria-invalid={errors.includes("skills")}>
        <legend className="text-sm font-medium">{t("skills")}</legend>
        <div className="mt-1 grid grid-cols-2 gap-1 sm:grid-cols-3">
          {TAXONOMY.skills.map((s) => (
            <label key={s.id} className="flex items-center gap-2 py-1 text-sm">
              <input type="checkbox" name="skills" value={s.id} />
              {s[locale]}
            </label>
          ))}
        </div>
        {err("skills")}
      </fieldset>
      <fieldset aria-invalid={errors.includes("languages")}>
        <legend className="text-sm font-medium">{t("languages")}</legend>
        <div className="mt-1 grid grid-cols-2 gap-1 sm:grid-cols-3">
          {TAXONOMY.languages.map((l) => (
            <label key={l.id} className="flex items-center gap-2 py-1 text-sm">
              <input type="checkbox" name="languages" value={l.id} />
              {l[locale]}
            </label>
          ))}
        </div>
        {err("languages")}
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="block text-sm font-medium">
          {t("gender")}
          <select name="gender" required defaultValue="" className={field}>
            <option value="" disabled>
              —
            </option>
            {TAXONOMY.genders.map((g) => (
              <option key={g.id} value={g.id}>
                {g[locale]}
              </option>
            ))}
          </select>
          {err("gender")}
        </label>
        <label className="block text-sm font-medium">
          {t("experience")}
          <input
            name="experience_years"
            type="number"
            inputMode="numeric"
            min={0}
            max={70}
            required
            className={field}
          />
          {err("experience_years")}
        </label>
        <label className="block text-sm font-medium">
          {t("price")}
          <input
            name="price_rupees"
            type="number"
            inputMode="decimal"
            min={MIN_PRICE_PAISE / 100}
            max={MAX_PRICE_PAISE / 100}
            step="1"
            required
            aria-describedby="price-hint"
            className={field}
          />
          {err("requested_price_per_min_paise")}
        </label>
      </div>
      <p id="price-hint" className="text-sm text-muted">
        {t("priceHint", {
          min: formatPaise(MIN_PRICE_PAISE, locale),
          max: formatPaise(MAX_PRICE_PAISE, locale),
        })}
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="accepts_terms" required className="mt-1" />
        <span>{t("terms")}</span>
      </label>
      {err("accepts_terms")}
      <p role="alert" aria-live="assertive">
        {err("invite_required")}
        {err("invite_invalid")}
        {err("already_applied")}
        {err("generic")}
      </p>
      <button
        type="submit"
        disabled={busy}
        className="rounded-sm bg-primary px-4 py-2 font-medium text-primary-fg"
      >
        {busy ? t("submitting") : t("submit")}
      </button>
    </form>
  );
}
