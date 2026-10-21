"use client";

import { useTranslations } from "next-intl";
import { useState, useSyncExternalStore } from "react";
import { discardQueued } from "@/lib/analytics/client";
import { OPT_OUT_COOKIE, OPT_OUT_URL } from "@/lib/analytics/config";

type State = "unknown" | "on" | "off";

/** The choice lives in the aid_off cookie; this tiny store re-reads it after each change. */
const listeners = new Set<() => void>();
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
const notify = () => listeners.forEach((cb) => cb());

function snapshot(): string {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  const browserOff = nav.globalPrivacyControl === true || nav.doNotTrack === "1";
  let off = false;
  try {
    off = document.cookie.split(";").some((c) => c.trim() === `${OPT_OUT_COOKIE}=1`);
  } catch {
    /* cookies unavailable: collection is off anyway */
  }
  return `${off ? "off" : "on"}|${browserOff ? "1" : "0"}`;
}
// The page is static: on the server (and during hydration) the choice is not known yet.
const serverSnapshot = () => "unknown|0";

/**
 * Privacy page switch (docs/api/growth.md §1.1): POST /api/e/opt-out turns analytics off for this
 * browser (sets aid_off, clears aid); DELETE turns it back on. The page is static, so the current
 * choice is read from the aid_off cookie in the browser.
 */
export function AnalyticsSwitch() {
  const t = useTranslations("growth.analytics");
  const [current, flag] = useSyncExternalStore(subscribe, snapshot, serverSnapshot).split("|");
  const state = current as State;
  const browserOff = flag === "1";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function toggle() {
    const next: State = state === "on" ? "off" : "on";
    setBusy(true);
    setError(false);
    try {
      const res = await fetch(OPT_OUT_URL, { method: next === "off" ? "POST" : "DELETE" });
      if (!res.ok) throw new Error(String(res.status));
      if (next === "off") discardQueued();
      notify();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  const checked = state === "on";
  return (
    <div
      className="space-y-2 rounded-md border border-border bg-surface p-4"
      data-testid="analytics-switch"
    >
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-labelledby="analytics-switch-label"
          disabled={busy || state === "unknown"}
          onClick={() => void toggle()}
          className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border border-border transition-colors disabled:opacity-60 ${
            checked ? "bg-primary" : "bg-bg"
          }`}
        >
          <span
            aria-hidden="true"
            className={`inline-block h-5 w-5 rounded-full bg-surface shadow transition-transform ${
              checked ? "translate-x-6" : "translate-x-1"
            }`}
          />
        </button>
        <span id="analytics-switch-label" className="font-medium">
          {t("label")}
        </span>
      </div>
      <p className="text-sm text-muted" aria-live="polite">
        {busy ? t("saving") : state === "off" ? t("off") : state === "on" ? t("on") : ""}
      </p>
      {browserOff && <p className="text-sm">{t("browserOff")}</p>}
      {error && (
        <p role="alert" className="text-sm" style={{ color: "var(--color-danger)" }}>
          {t("error")}
        </p>
      )}
    </div>
  );
}
