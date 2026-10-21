"use client";

import { useState } from "react";
import type { FlaggedMessage } from "@/lib/trust-admin";
import { revealFlaggedMessage } from "./actions";

/**
 * "Reveal flagged message" for a safety item, behind an explicit confirm. The text stays in
 * this component's state only; "Hide" drops it.
 */
export function RevealMessage({ id }: { id: string }) {
  const [step, setStep] = useState<"idle" | "confirm" | "loading">("idle");
  const [message, setMessage] = useState<FlaggedMessage | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reveal() {
    setStep("loading");
    setError(null);
    const r = await revealFlaggedMessage(id);
    setStep("idle");
    if (r.ok) setMessage(r.message);
    else setError(r.error);
  }

  if (message) {
    return (
      <div className="space-y-2">
        <blockquote className="max-w-prose whitespace-pre-wrap break-words rounded-sm border-l-4 border-accent bg-bg px-3 py-2 text-sm">
          {message.text}
        </blockquote>
        <p className="text-xs text-muted">
          Revealed and logged with your name. Do not copy it anywhere else.
        </p>
        <button
          type="button"
          onClick={() => setMessage(null)}
          className="rounded-sm border border-border px-3 py-1.5 text-sm"
        >
          Hide message
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {step === "idle" ? (
        <button
          type="button"
          onClick={() => setStep("confirm")}
          className="rounded-sm border border-border px-3 py-1.5 text-sm"
        >
          Reveal flagged message
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">
            This is logged with your name. Reveal the client&apos;s message?
          </span>
          <button
            type="button"
            disabled={step === "loading"}
            onClick={() => void reveal()}
            className="rounded-sm bg-primary px-3 py-1.5 text-sm text-primary-fg disabled:opacity-60"
          >
            Yes, reveal
          </button>
          <button
            type="button"
            onClick={() => setStep("idle")}
            className="rounded-sm border border-border px-3 py-1.5 text-sm"
          >
            Cancel
          </button>
        </div>
      )}
      <p role="status" aria-live="polite" className="text-sm text-danger">
        {error}
      </p>
    </div>
  );
}
