"use client";

import { useActionState, useState } from "react";
import { formatRupees, rupeesToPaise } from "@/lib/money";
import { keyAfter, newIdempotencyKey } from "@/lib/money-admin";
import type { ActionResult } from "@/lib/result";
import { manualRefund } from "../actions";

/**
 * Two-step refund form. The Idempotency-Key is created with the form, sent with every submit,
 * kept when the outcome is unknown (so "Retry" cannot pay twice) and replaced after any
 * definite answer.
 */
export function RefundForm({
  defaultSessionId,
  initialKey,
}: {
  defaultSessionId: string;
  initialKey: string;
}) {
  const [key, setKey] = useState(initialKey);
  const [sessionId, setSessionId] = useState(defaultSessionId);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [submittedKey, setSubmittedKey] = useState<string | null>(null);
  const [state, formAction, pending] = useActionState(
    async (prev: ActionResult | null, fd: FormData) => {
      setSubmittedKey(String(fd.get("idempotency_key") ?? ""));
      const r = await manualRefund(prev, fd);
      setKey((k) => keyAfter(k, r));
      setConfirming(false);
      if (r.ok) {
        setAmount("");
        setNote("");
      }
      return r;
    },
    null,
  );
  const paise = rupeesToPaise(amount);
  const ready = sessionId.trim() !== "" && paise !== null && paise > 0 && note.trim().length >= 5;
  // Outcome unknown for the current key: the same refund may only be retried, not edited.
  const retry = state?.ok === false && state.retryable === true && submittedKey === key;

  return (
    <form action={formAction} className="mt-4 grid gap-3 sm:grid-cols-[1fr_10rem]">
      <input type="hidden" name="idempotency_key" value={key} readOnly />
      <label className="block text-sm">
        Session id
        <input
          name="session_id"
          required
          value={sessionId}
          readOnly={retry}
          onChange={(e) => {
            setSessionId(e.target.value);
            setConfirming(false);
          }}
          className="mt-1 w-full rounded-sm border border-border bg-bg px-2 py-1 font-mono"
        />
      </label>
      <label className="block text-sm">
        Amount (₹)
        <input
          name="amount_rupees"
          required
          inputMode="decimal"
          value={amount}
          readOnly={retry}
          onChange={(e) => {
            setAmount(e.target.value);
            setConfirming(false);
          }}
          className="mt-1 w-full rounded-sm border border-border bg-bg px-2 py-1"
        />
      </label>
      <label className="block text-sm sm:col-span-2">
        Note (why, for the audit log; no phone numbers or chat text)
        <textarea
          name="note"
          required
          minLength={5}
          maxLength={500}
          rows={2}
          value={note}
          readOnly={retry}
          onChange={(e) => {
            setNote(e.target.value);
            setConfirming(false);
          }}
          className="mt-1 w-full rounded-sm border border-border bg-bg px-2 py-1"
        />
      </label>
      <div className="space-y-2 sm:col-span-2">
        {!confirming && !retry ? (
          <button
            type="button"
            disabled={!ready}
            onClick={() => setConfirming(true)}
            className="rounded-sm bg-primary px-3 py-1.5 text-sm text-primary-fg disabled:opacity-60"
          >
            Review refund
          </button>
        ) : (
          <div className="rounded-md border border-border p-3 text-sm">
            <p className="font-medium">
              Refund {paise !== null ? formatRupees(paise) : "–"} to the client of session{" "}
              <span className="font-mono">{sessionId.trim()}</span>?
            </p>
            <p className="mt-1 text-muted">
              The amount is credited to the client&apos;s wallet through a ledger entry, and the
              refund is written to the audit log under your admin account with this note. It cannot
              be undone from here.
            </p>
            {retry && (
              <p className="mt-1 text-muted">
                Check the list below first: if the refund is there, it went through. Retrying reuses
                the same request key, so the client cannot be paid twice.
              </p>
            )}
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="submit"
                disabled={pending || !ready}
                className="rounded-sm bg-danger px-3 py-1.5 text-primary-fg disabled:opacity-60"
              >
                {retry ? "Retry refund" : "Yes, refund"}
              </button>
              {retry ? (
                <button
                  type="button"
                  onClick={() => {
                    setKey(newIdempotencyKey());
                    setConfirming(false);
                  }}
                  className="rounded-sm border border-border px-3 py-1.5"
                >
                  Start over as a new refund
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="rounded-sm border border-border px-3 py-1.5"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        )}
        <div role="status" aria-live="polite" className="text-sm">
          {state?.ok === true && <span className="text-success">{state.message}</span>}
          {state?.ok === false && (state.retryable !== true || submittedKey === key) && (
            <span className="text-danger">
              {state.retryable
                ? `The API did not confirm the refund (${state.error}). It may or may not have gone through.`
                : state.error}
            </span>
          )}
        </div>
      </div>
    </form>
  );
}
