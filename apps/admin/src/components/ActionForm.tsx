"use client";

import { useActionState, useState, type ReactNode } from "react";
import type { ActionResult } from "@/lib/result";

type Action = (prev: ActionResult | null, form: FormData) => Promise<ActionResult>;

/**
 * Form bound to a Server Action. Destructive actions (`confirm`) need a second, explicit click;
 * the result is announced to screen readers.
 */
export function ActionForm({
  action,
  submitLabel,
  confirm,
  destructive = false,
  children,
  className = "",
}: {
  action: Action;
  submitLabel: string;
  confirm?: string;
  destructive?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const [confirming, setConfirming] = useState(false);
  const button = destructive ? "bg-danger text-primary-fg" : "bg-primary text-primary-fg";
  return (
    <form
      action={(fd) => {
        setConfirming(false);
        formAction(fd);
      }}
      className={`space-y-2 ${className}`}
    >
      {children}
      <div className="flex flex-wrap items-center gap-2">
        {confirm && !confirming ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className={`rounded-sm px-3 py-1.5 text-sm ${button}`}
          >
            {submitLabel}
          </button>
        ) : (
          <>
            {confirm && <span className="text-sm font-medium">{confirm}</span>}
            <button
              type="submit"
              disabled={pending}
              className={`rounded-sm px-3 py-1.5 text-sm disabled:opacity-60 ${button}`}
            >
              {confirm ? `Yes, ${submitLabel.toLowerCase()}` : submitLabel}
            </button>
            {confirm && (
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-sm border border-border px-3 py-1.5 text-sm"
              >
                Cancel
              </button>
            )}
          </>
        )}
      </div>
      <div role="status" aria-live="polite" className="text-sm">
        {state?.ok === true && <span className="text-success">{state.message ?? "Saved."}</span>}
        {state?.ok === false && (
          <span className="text-danger">
            {state.error}
            {state.errors && state.errors.length > 0 && (
              <ul className="mt-1 list-disc pl-5">
                {state.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
          </span>
        )}
      </div>
    </form>
  );
}
