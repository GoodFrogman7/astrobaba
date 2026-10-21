"use client";

import type { ConsultSettings } from "@astro/shared";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { callToggle, consultErrorText } from "@/lib/consult";
import { isConsentRequired } from "@/lib/trust";
import { useOpenTermsGate } from "@/lib/use-terms-gate";

type Key = "chat_enabled" | "call_enabled";

export function ConsultToggles({ initial }: { initial: ConsultSettings }) {
  const router = useRouter();
  const openTermsGate = useOpenTermsGate();
  const [settings, setSettings] = useState(initial);
  const [refused, setRefused] = useState(false);
  const [busy, setBusy] = useState<Key | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const call = callToggle(settings, refused);

  async function set(key: Key, value: boolean) {
    setBusy(key);
    setStatus(null);
    try {
      const r = await fetch("/api/portal/consult", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
      if (r.status === 401) {
        router.replace("/login");
        return;
      }
      const body = (await r.json().catch(() => ({}))) as Partial<ConsultSettings> & {
        code?: string;
      };
      if (isConsentRequired(r.status, body)) {
        setStatus({ ok: false, text: "Not saved: accept the astrologer terms first." });
        openTermsGate();
        return;
      }
      if (r.ok) {
        setSettings((s) => ({ ...s, ...body }));
        setStatus({ ok: true, text: "Saved." });
        return;
      }
      if (body.code === "call_unavailable") {
        setRefused(true);
        setSettings((s) => ({ ...s, voice_calls_available: false }));
      }
      setStatus({ ok: false, text: consultErrorText(body.code) });
    } catch {
      setStatus({ ok: false, text: "Network error. Try again." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-4 space-y-4">
      <Toggle
        id="chat"
        label="Chat"
        help={
          settings.chat_enabled
            ? "Clients can send you chat requests while you are online."
            : "Chat is off: you can't go online for chat requests until you turn it back on."
        }
        checked={settings.chat_enabled}
        disabled={busy !== null}
        onChange={(v) => void set("chat_enabled", v)}
      />
      <Toggle
        id="call"
        label="Voice calls"
        help={
          call.reason ??
          (settings.call_enabled
            ? "Clients can request in-app voice calls while you are online. You need a working microphone and this tab open."
            : "Turn on to take in-app voice calls at the same price per minute as chat.")
        }
        checked={settings.call_enabled}
        disabled={busy !== null || call.disabled}
        onChange={(v) => void set("call_enabled", v)}
      />
      <p role="status" aria-live="polite" className="text-sm">
        {status && (
          <span className={status.ok ? "text-success" : "text-danger"}>{status.text}</span>
        )}
      </p>
    </div>
  );
}

function Toggle({
  id,
  label,
  help,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  help: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-4">
      <button
        type="button"
        role="switch"
        id={`toggle-${id}`}
        aria-checked={checked}
        aria-describedby={`toggle-${id}-help`}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-border transition disabled:opacity-50 ${
          checked ? "bg-success" : "bg-bg"
        }`}
      >
        <span className="sr-only">{label}</span>
        <span
          aria-hidden="true"
          className={`inline-block size-5 rounded-full bg-surface shadow transition ${
            checked ? "translate-x-5" : "translate-x-0.5"
          }`}
        />
      </button>
      <div>
        <label htmlFor={`toggle-${id}`} className="font-medium">
          {label} <span className="text-sm text-muted">({checked ? "on" : "off"})</span>
        </label>
        <p id={`toggle-${id}-help`} className="text-sm text-muted">
          {help}
        </p>
      </div>
    </div>
  );
}
