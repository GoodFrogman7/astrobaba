"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { REPLY_MAX_CHARS, replyErrorText } from "@/lib/reviews";

/** One reply per review, final once sent: a two-step send so it is never posted by accident. */
export function ReplyForm({ reviewId }: { reviewId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const trimmed = text.trim();
  const tooLong = trimmed.length > REPLY_MAX_CHARS;
  const fieldId = `reply-${reviewId}`;

  if (sent !== null) {
    return (
      <div className="mt-3 border-l-2 border-primary pl-3" role="status">
        <p className="text-xs text-muted">Your reply · just now</p>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm">{sent}</p>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 rounded-sm border border-border px-3 py-1.5 text-sm"
      >
        Reply
      </button>
    );
  }

  async function send() {
    setSending(true);
    setError(null);
    try {
      const r = await fetch(`/api/reviews/${encodeURIComponent(reviewId)}/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: trimmed }),
      });
      if (r.status === 401) {
        router.replace("/login");
        return;
      }
      const body = (await r.json().catch(() => ({}))) as {
        code?: string;
        message?: string;
        reply?: { text?: string };
      };
      if (r.ok) {
        setSent(body.reply?.text ?? trimmed);
        router.refresh();
        return;
      }
      setError(replyErrorText(body.code, body.message));
      if (body.code === "already_replied") router.refresh();
    } catch {
      setError("Network error. Your reply is still here; try again.");
    } finally {
      setSending(false);
      setConfirming(false);
    }
  }

  return (
    <div className="mt-3 space-y-2">
      <label htmlFor={fieldId} className="block text-sm font-medium">
        Your reply (public; one reply only, it cannot be edited later)
      </label>
      <textarea
        id={fieldId}
        rows={3}
        value={text}
        maxLength={REPLY_MAX_CHARS + 200}
        onChange={(e) => {
          setText(e.target.value);
          setConfirming(false);
        }}
        className="w-full rounded-sm border border-border bg-bg px-3 py-2 text-sm"
      />
      <p className={`text-xs ${tooLong ? "text-danger" : "text-muted"}`}>
        {trimmed.length}/{REPLY_MAX_CHARS} characters. No phone numbers, links or promises about
        outcomes.
      </p>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {confirming ? (
          <>
            <span className="font-medium">
              Send this reply? You can&apos;t change it afterwards.
            </span>
            <button
              type="button"
              disabled={sending}
              onClick={() => void send()}
              className="rounded-sm bg-primary px-3 py-1.5 text-primary-fg disabled:opacity-60"
            >
              {sending ? "Sending…" : "Yes, send reply"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-sm border border-border px-3 py-1.5"
            >
              Keep editing
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={!trimmed || tooLong}
              onClick={() => setConfirming(true)}
              className="rounded-sm bg-primary px-3 py-1.5 text-primary-fg disabled:opacity-60"
            >
              Send reply
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setText("");
                setError(null);
              }}
              className="rounded-sm border border-border px-3 py-1.5"
            >
              Cancel
            </button>
          </>
        )}
      </div>
      <p role="status" aria-live="polite" className="text-sm text-danger">
        {error}
      </p>
    </div>
  );
}
