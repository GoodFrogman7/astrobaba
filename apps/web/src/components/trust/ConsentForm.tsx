"use client";

import type { ConsentKind, ConsentState } from "@astro/shared";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Link } from "@/i18n/navigation";
import { rawCall } from "@/lib/billing/client";
import {
  acceptConsents,
  kindsToAsk,
  validateConsent,
  type ConsentFormError,
  type Fetcher,
} from "@/lib/trust/consent";

type Message = "stale" | "signin" | "network" | "generic" | null;

/**
 * The age gate and consent step (docs/api/trust.md §1): "I am 18 or older" and "I agree to the
 * Terms and the Privacy notice", both unticked until the user ticks them, accepted at the
 * policy version shown. The policies open in a new tab so this step is not lost.
 */
export function ConsentForm({
  state: initial,
  kinds: initialKinds,
  onAccepted,
  fetcher = rawCall as Fetcher,
}: {
  state: ConsentState;
  kinds: ConsentKind[];
  onAccepted: (state: ConsentState) => void;
  fetcher?: Fetcher;
}) {
  const t = useTranslations("trust.consent");
  const id = useId();
  const [state, setState] = useState(initial);
  const [kinds, setKinds] = useState(initialKinds);
  const [adult, setAdult] = useState(false);
  const [terms, setTerms] = useState(false);
  const [errors, setErrors] = useState<ConsentFormError[]>([]);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const askAge = kinds.includes("age_18");
  const askTerms = kinds.includes("terms") || kinds.includes("privacy");
  const updated = state.accepted.length > 0;

  async function submit() {
    const invalid = validateConsent(kinds, { adult, terms });
    setErrors(invalid);
    setMessage(null);
    if (invalid.length) return;
    setBusy(true);
    const r = await acceptConsents(state.version, kinds, fetcher);
    setBusy(false);
    if (r.kind === "accepted") return onAccepted(r.state);
    if (r.kind === "stale") {
      // A newer version was published while the step was open: show it, ask again.
      if (r.state) {
        setState(r.state);
        setKinds(kindsToAsk(r.state));
      }
      setAdult(false);
      setTerms(false);
      return setMessage("stale");
    }
    setMessage(r.kind === "signin" ? "signin" : r.key);
  }

  const link = (href: string) =>
    function PolicyLink(chunks: React.ReactNode) {
      return (
        <Link
          href={href}
          target="_blank"
          rel="noopener"
          className="font-medium text-accent underline"
        >
          {chunks}
        </Link>
      );
    };

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="space-y-4"
      data-testid="consent-form"
    >
      <p>{updated ? t("updated") : t("intro")}</p>
      <fieldset className="space-y-3">
        <legend className="sr-only">{t("title")}</legend>
        {askAge && (
          <div>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                name="age_18"
                required
                checked={adult}
                onChange={(e) => setAdult(e.target.checked)}
                aria-invalid={errors.includes("age") || undefined}
                aria-describedby={errors.includes("age") ? `${id}-age` : undefined}
                className="mt-1 size-4"
                data-testid="consent-age"
              />
              <span>{t("age")}</span>
            </label>
            {errors.includes("age") && (
              <p id={`${id}-age`} className="mt-1 text-sm text-danger">
                {t("errors.age")}
              </p>
            )}
          </div>
        )}
        {askTerms && (
          <div>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                name="terms"
                required
                checked={terms}
                onChange={(e) => setTerms(e.target.checked)}
                aria-invalid={errors.includes("terms") || undefined}
                aria-describedby={errors.includes("terms") ? `${id}-terms` : undefined}
                className="mt-1 size-4"
                data-testid="consent-terms"
              />
              <span>{t.rich("terms", { terms: link("/terms"), privacy: link("/privacy") })}</span>
            </label>
            {errors.includes("terms") && (
              <p id={`${id}-terms`} className="mt-1 text-sm text-danger">
                {t("errors.terms")}
              </p>
            )}
          </div>
        )}
      </fieldset>
      <p className="text-sm text-muted" data-testid="consent-version">
        {t("version", { version: state.version })}
      </p>
      <p className="text-sm text-muted">{t("under18")}</p>
      <p role="alert" className="text-sm text-danger">
        {message ? t(`errors.${message}`) : ""}
      </p>
      <button
        type="submit"
        disabled={busy}
        className="rounded-sm bg-primary px-4 py-2 font-medium text-primary-fg disabled:opacity-60"
      >
        {busy ? t("busy") : t("submit")}
      </button>
    </form>
  );
}
