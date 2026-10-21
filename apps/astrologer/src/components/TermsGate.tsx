"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { acceptTerms } from "@/lib/trust";

/**
 * Accept the astrologer terms: an unticked checkbox, then one button. Nothing is sent until the
 * box is ticked. After accepting, the page that was gated loads again (or `next`, when the gate
 * was opened by a refused portal write).
 */
export function TermsGate({ version, next }: { version: string; next?: string | null }) {
  const router = useRouter();
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!agreed || busy) return;
    setBusy(true);
    setError(null);
    const r = await acceptTerms(version);
    if (r.ok) {
      if (next) router.replace(next);
      router.refresh();
      return;
    }
    setBusy(false);
    setError(r.error);
  }

  return (
    <form
      className="mt-6 space-y-3 rounded-md border border-border bg-surface p-5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          name="agree"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          className="mt-1 size-4"
        />
        <span>
          I have read the astrologer terms (version {version}) and I will follow the conduct rules
          above.
        </span>
      </label>
      <button
        type="submit"
        disabled={!agreed || busy}
        className="rounded-sm bg-primary px-4 py-2 font-medium text-primary-fg disabled:opacity-60"
      >
        {busy ? "Saving…" : "Accept and continue"}
      </button>
      <p role="status" aria-live="polite" className="text-sm text-danger">
        {error}
      </p>
    </form>
  );
}
