"use client";

import type { Locale, SafetyResources } from "@astro/shared";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { BUNDLED_RESOURCES, loadResourcesClient, telHref } from "@/lib/trust/resources";

/** Helplines from GET /api/safety/resources; the verified file until it answers (or if not). */
export function useSafetyResources(): SafetyResources {
  const [r, setR] = useState<SafetyResources>(BUNDLED_RESOURCES);
  useEffect(() => {
    let live = true;
    void loadResourcesClient().then((x) => live && setR(x));
    return () => {
      live = false;
    };
  }, []);
  return r;
}

/** Numbers and the not-a-helpline text, shared by the crisis panel and the /safety page. */
export function HelplineList({
  resources,
  locale,
}: {
  resources: SafetyResources;
  locale: Locale;
}) {
  const t = useTranslations("trust.safety");
  return (
    <ul className="grid gap-3 sm:grid-cols-2" data-testid="helplines">
      {resources.helplines.map((h) => (
        <li key={h.id} className="space-y-1 rounded-md border border-border bg-bg p-4">
          <p className="font-semibold">{h.name[locale]}</p>
          <p>
            <a
              href={telHref(h.number)}
              className="inline-block rounded-sm bg-primary px-4 py-2 text-lg font-semibold text-primary-fg tabular-nums"
              data-testid="helpline-call"
            >
              {t("call", { number: h.number })}
            </a>
          </p>
          <p className="text-sm">
            <span className="text-muted">{t("hours")}: </span>
            {h.hours[locale]}
          </p>
          {h.official_site && (
            <p className="text-sm">
              <a
                href={h.official_site}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent underline"
              >
                {t("officialSite")}
              </a>
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Shown when self-harm language is detected (docs/api/trust.md §3): calm, prominent, with
 * tap-to-call numbers, the not-a-helpline text and, in a consultation, a way to end it now.
 * Focus moves to the heading so screen-reader users hear it first.
 */
export function CrisisPanel({
  onEnd,
  upsellPaused = false,
  focus = true,
}: {
  onEnd?: () => Promise<boolean>;
  upsellPaused?: boolean;
  /** Move focus to the panel when it appears (consultations); off in lists (AI answers). */
  focus?: boolean;
}) {
  const t = useTranslations("trust.safety");
  const locale = useLocale() as Locale;
  const resources = useSafetyResources();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [ending, setEnding] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (focus) heading.current?.focus();
  }, [focus]);

  return (
    <section
      aria-labelledby={id}
      className="space-y-3 rounded-md border-2 border-accent bg-surface p-5"
      data-testid="crisis-panel"
    >
      <h2 id={id} ref={heading} tabIndex={-1} className="text-xl font-semibold">
        {t("panelTitle")}
      </h2>
      <p>{t("panelBody")}</p>
      <HelplineList resources={resources} locale={locale} />
      <p className="font-medium" data-testid="not-a-helpline">
        {resources.not_a_helpline[locale]}
      </p>
      {upsellPaused && <p className="text-sm text-muted">{t("upsellPaused")}</p>}
      {onEnd && (
        <div className="space-y-2">
          <button
            type="button"
            disabled={ending}
            onClick={async () => {
              setEnding(true);
              const ok = await onEnd();
              setFailed(!ok);
              setEnding(false);
            }}
            className="rounded-sm border border-border px-4 py-2 font-medium disabled:opacity-60"
            data-testid="crisis-end"
          >
            {ending ? t("ending") : t("end")}
          </button>
          {failed && <p role="alert">{t("endError")}</p>}
        </div>
      )}
    </section>
  );
}
