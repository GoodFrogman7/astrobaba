"use client";

import { useActionState, useState } from "react";
import { INVITE_NOTE_MAX, parseInviteForm } from "@/lib/growth-admin";
import { formatIst } from "@/lib/money-admin";
import { createInvite, type CreateInviteResult } from "./actions";

function CopyButton({ text, label }: { text: string; label: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setStatus("copied");
          } catch {
            setStatus("failed");
          }
        }}
        className="rounded-sm border border-border px-2 py-1 text-xs"
      >
        {label}
      </button>
      <span role="status" aria-live="polite" className="text-xs">
        {status === "copied" && <span className="text-success">Copied</span>}
        {status === "failed" && (
          <span className="text-danger">Could not copy; select the text and copy it.</span>
        )}
      </span>
    </span>
  );
}

/**
 * Create an invite. The code and link are shown once, from this component's state only; after
 * "Done" (or a reload) they are gone for good, because the API stores only a hash.
 */
export function InviteCreateForm() {
  const [note, setNote] = useState("");
  const [days, setDays] = useState("14");
  const [clientError, setClientError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<string | null>(null);
  const [state, formAction, pending] = useActionState(
    async (prev: CreateInviteResult | null, fd: FormData) => {
      const r = await createInvite(prev, fd);
      if (r.ok) {
        setNote("");
        setDays("14");
      }
      return r;
    },
    null,
  );
  const created = state?.ok === true && hidden !== state.invite.id ? state.invite : null;

  return (
    <div className="space-y-4">
      {created && (
        <div
          className="rounded-md border-2 border-accent bg-surface p-4 text-sm"
          role="region"
          aria-label="New invite"
        >
          <p className="font-semibold">
            Invite created. Copy it now: it won&apos;t be shown again.
          </p>
          <p className="mt-1 text-muted">
            Only a hash of the code is stored. If it is lost, revoke this invite and create a new
            one. Send it to the astrologer privately. Expires {formatIst(created.expires_at)} IST.
          </p>
          <dl className="mt-3 space-y-2">
            <div>
              <dt className="text-xs text-muted">Code</dt>
              <dd className="flex flex-wrap items-center gap-2">
                <code className="rounded-sm bg-bg px-2 py-1 font-mono text-base tracking-widest">
                  {created.code}
                </code>
                <CopyButton text={created.code} label="Copy code" />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Application link</dt>
              <dd className="flex flex-wrap items-center gap-2">
                <code className="break-all rounded-sm bg-bg px-2 py-1 font-mono text-xs">
                  {created.url}
                </code>
                <CopyButton text={created.url} label="Copy link" />
              </dd>
            </div>
          </dl>
          <button
            type="button"
            onClick={() => setHidden(created.id)}
            className="mt-3 rounded-sm border border-border px-3 py-1.5"
          >
            Done, I have copied it
          </button>
        </div>
      )}
      <form
        action={formAction}
        onSubmit={(e) => {
          const fd = new FormData(e.currentTarget);
          const p = parseInviteForm({
            note: String(fd.get("note") ?? ""),
            expires_days: String(fd.get("expires_days") ?? ""),
          });
          if (!p.ok) {
            e.preventDefault();
            setClientError(p.error);
          } else {
            setClientError(null);
          }
        }}
        className="grid gap-3 sm:grid-cols-[1fr_10rem]"
      >
        <label className="block text-sm">
          Note (optional, admin-only; e.g. who it is for, no phone numbers)
          <input
            name="note"
            value={note}
            maxLength={INVITE_NOTE_MAX}
            onChange={(e) => setNote(e.target.value)}
            className="mt-1 w-full rounded-sm border border-border bg-bg px-2 py-1"
          />
          <span className="mt-0.5 block text-xs text-muted">
            {note.length}/{INVITE_NOTE_MAX}
          </span>
        </label>
        <label className="block text-sm">
          Expires after (days)
          <input
            name="expires_days"
            type="number"
            min={1}
            max={60}
            step={1}
            required
            value={days}
            onChange={(e) => setDays(e.target.value)}
            className="mt-1 w-full rounded-sm border border-border bg-bg px-2 py-1"
          />
        </label>
        <div className="sm:col-span-2">
          <button
            type="submit"
            disabled={pending}
            className="rounded-sm bg-primary px-3 py-1.5 text-sm text-primary-fg disabled:opacity-60"
          >
            Create invite
          </button>
          <div role="status" aria-live="polite" className="mt-2 text-sm">
            {clientError && <span className="text-danger">{clientError}</span>}
            {!clientError && state?.ok === false && (
              <span className="text-danger">
                {state.retryable
                  ? `The API did not confirm the invite (${state.error}). Check the list before trying again.`
                  : state.error}
              </span>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
