"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

/** POST JSON to one of our route handlers; the body is {} when the answer is not JSON. */
export async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body: json };
}

/**
 * Phone OTP sign-in (same /api/auth routes as "Save my kundli"). The token lands in an
 * httpOnly cookie set by the route handler; this component never sees it.
 */
export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const t = useTranslations("market.signin");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const err = (c: unknown) =>
    t.has(`errors.${String(c)}`) ? t(`errors.${String(c)}`) : t("errors.generic");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (!challenge) {
        const r = await postJson("/api/auth/otp/request", { phone });
        if (r.status === 202) setChallenge(String(r.body.challenge_id));
        else setError(err(r.body.code));
      } else {
        const r = await postJson("/api/auth/otp/verify", { challenge_id: challenge, code });
        if (r.status === 200) onSignedIn();
        else setError(err(r.body.code));
      }
    } catch {
      setError(t("errors.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="max-w-sm space-y-3 rounded-md border border-border bg-surface p-5"
    >
      <h2 className="text-lg font-semibold">{t("title")}</h2>
      {!challenge ? (
        <>
          <label className="block text-sm">
            {t("phone")}
            <input
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              required
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="mt-1 w-full rounded-sm border border-border bg-surface px-3 py-2"
            />
          </label>
          <p className="text-sm text-muted">{t("consent")}</p>
        </>
      ) : (
        <>
          <label className="block text-sm">
            {t("code")}
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              required
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              className="mt-1 w-full rounded-sm border border-border bg-surface px-3 py-2 font-mono tracking-widest"
            />
          </label>
          <button
            type="button"
            className="py-1 text-sm underline"
            onClick={() => {
              setChallenge(null);
              setCode("");
            }}
          >
            {t("change")}
          </button>
        </>
      )}
      <p
        role="alert"
        aria-live="assertive"
        className="text-sm"
        style={{ color: "var(--color-danger)" }}
      >
        {error}
      </p>
      <button
        type="submit"
        disabled={busy}
        className="rounded-sm bg-primary px-4 py-2 font-medium text-primary-fg"
      >
        {busy ? t("busy") : challenge ? t("verify") : t("send")}
      </button>
    </form>
  );
}
