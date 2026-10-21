"use client";

import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { track } from "@/lib/analytics/client";
import { requestConsent } from "@/lib/trust/consent";
import { postJson } from "@/components/marketplace/SignIn";
import type { BirthInput } from "@/lib/tools/types";

type Step = "name" | "phone" | "code" | "saved";

/** Optional sign-in by OTP to save a kundli (PLAN.md §5 Phase 2 funnel). */
export function SaveKundli({ birth }: { birth: BirthInput }) {
  const t = useTranslations("toolsUi.save");
  const dialog = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState<Step>("name");
  const [name, setName] = useState(birth.name ?? "");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const errorText = (c: string) => (t.has(`errors.${c}`) ? t(`errors.${c}`) : t("errors.generic"));

  async function save(): Promise<boolean> {
    const r = await postJson("/api/kundlis", { name: name.trim(), birth });
    if (r.status === 201) {
      setStep("saved");
      return true;
    }
    if (r.status !== 401) setError(errorText(String(r.body.code ?? "")));
    return false;
  }

  async function next() {
    setError("");
    setBusy(true);
    try {
      if (step === "name") {
        if (!name.trim()) return;
        const s = await fetch("/api/auth/session").then(
          (r) => r.json() as Promise<{ signed_in?: boolean }>,
        );
        if (s.signed_in && (await save())) return;
        setStep("phone");
      } else if (step === "phone") {
        const r = await postJson("/api/auth/otp/request", { phone });
        if (r.status === 202) {
          setChallenge(String(r.body.challenge_id));
          setStep("code");
          track("otp_requested", { source: "save-kundli" });
        } else setError(errorText(String(r.body.code ?? "")));
      } else if (step === "code") {
        const r = await postJson("/api/auth/otp/verify", { challenge_id: challenge, code });
        if (r.status === 200) {
          await save();
          // Saving a kundli needs no consent; a new sign-in still gets the consent step.
          void requestConsent();
        } else setError(errorText(String(r.body.code ?? "")));
      }
    } catch {
      setError(t("errors.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => dialog.current?.showModal()}
        className="rounded-sm border border-primary px-4 py-2 font-medium text-primary"
      >
        {t("button")}
      </button>
      <dialog
        ref={dialog}
        aria-labelledby="save-title"
        className="w-[min(28rem,calc(100vw-2rem))] rounded-md border border-border bg-surface p-5 text-fg backdrop:bg-black/40"
      >
        <form
          method="dialog"
          onSubmit={(e) => {
            if (step !== "saved") {
              e.preventDefault();
              void next();
            }
          }}
          className="space-y-4"
        >
          <h2 id="save-title" className="text-lg font-semibold">
            {t("title")}
          </h2>
          {step === "name" && (
            <label className="block text-sm">
              {t("nameLabel")}
              <input
                value={name}
                maxLength={60}
                required
                onChange={(e) => setName(e.target.value)}
                className="mt-1 w-full rounded-sm border border-border bg-surface px-3 py-2"
              />
            </label>
          )}
          {step === "phone" && (
            <>
              <label className="block text-sm">
                {t("phone")}
                <input
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  value={phone}
                  required
                  onChange={(e) => setPhone(e.target.value)}
                  className="mt-1 w-full rounded-sm border border-border bg-surface px-3 py-2"
                />
              </label>
              <p className="text-sm text-muted">{t("consent")}</p>
            </>
          )}
          {step === "code" && (
            <label className="block text-sm">
              {t("code")}
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                value={code}
                required
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                className="mt-1 w-full rounded-sm border border-border bg-surface px-3 py-2 font-mono tracking-widest"
              />
            </label>
          )}
          {step === "saved" && <p role="status">{t("saved")}</p>}
          <p aria-live="assertive" className="text-sm text-danger">
            {error}
          </p>
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={() => dialog.current?.close()}
              className="px-3 py-2 text-sm"
            >
              {t("close")}
            </button>
            {step !== "saved" && (
              <button
                type="submit"
                disabled={busy}
                className="rounded-sm bg-primary px-4 py-2 text-sm font-medium text-primary-fg disabled:opacity-60"
              >
                {step === "phone" ? t("sendCode") : step === "code" ? t("verify") : t("button")}
              </button>
            )}
          </div>
        </form>
      </dialog>
    </>
  );
}
