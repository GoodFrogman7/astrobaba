"use client";

import { useActionState, useState } from "react";
import type { ActionResult } from "@/lib/result";
import {
  ACTION_CONFIRM,
  ACTION_EFFECT,
  ACTION_LABEL,
  MODERATION_ACTIONS,
  NOTE_MAX,
  NOTE_MIN,
  type ModerationAction,
} from "@/lib/trust-admin";

type Action = (prev: ActionResult | null, form: FormData) => Promise<ActionResult>;

/**
 * Dismiss / warn / suspend with a required note. The chosen action's effect is spelled out, and
 * nothing is sent until the admin confirms it.
 */
export function ModerationActions({ action, canSuspend }: { action: Action; canSuspend: boolean }) {
  const [state, formAction, pending] = useActionState(action, null);
  const [choice, setChoice] = useState<ModerationAction>("dismiss");
  const [confirming, setConfirming] = useState(false);
  const options = MODERATION_ACTIONS.filter((a) => a !== "suspend" || canSuspend);
  const destructive = choice === "suspend";

  return (
    <form
      action={(fd) => {
        setConfirming(false);
        formAction(fd);
      }}
      className="space-y-2"
    >
      <fieldset className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <legend className="sr-only">Action</legend>
        {options.map((a) => (
          <label key={a} className="inline-flex items-center gap-1.5">
            <input
              type="radio"
              name="action"
              value={a}
              checked={choice === a}
              onChange={() => {
                setChoice(a);
                setConfirming(false);
              }}
            />
            {ACTION_LABEL[a]}
          </label>
        ))}
      </fieldset>
      <p className={`text-sm ${destructive ? "text-danger" : "text-muted"}`}>
        {ACTION_EFFECT[choice]}
      </p>
      <label className="block text-sm">
        Note (required, kept in the audit log)
        <textarea
          name="note"
          required
          minLength={NOTE_MIN}
          maxLength={NOTE_MAX}
          rows={2}
          className="mt-1 block w-full rounded-sm border border-border bg-bg px-2 py-1"
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        {!confirming ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className={`rounded-sm px-3 py-1.5 text-sm ${destructive ? "bg-danger" : "bg-primary"} text-primary-fg`}
          >
            {ACTION_LABEL[choice]}
          </button>
        ) : (
          <>
            <span className="text-sm font-medium">{ACTION_CONFIRM[choice]}</span>
            <button
              type="submit"
              disabled={pending}
              className={`rounded-sm px-3 py-1.5 text-sm text-primary-fg disabled:opacity-60 ${destructive ? "bg-danger" : "bg-primary"}`}
            >
              Yes, {ACTION_LABEL[choice].toLowerCase()}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-sm border border-border px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
          </>
        )}
      </div>
      <div role="status" aria-live="polite" className="text-sm">
        {state?.ok === true && <span className="text-success">{state.message ?? "Done."}</span>}
        {state?.ok === false && <span className="text-danger">{state.error}</span>}
      </div>
    </form>
  );
}
