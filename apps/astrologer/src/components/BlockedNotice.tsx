import Link from "next/link";
import { blockedNotice } from "@/lib/trust";

/** Next to the composer after `error message_blocked` (trust.md §3): the message was not sent. */
export function BlockedNotice({
  reason,
  onDismiss,
}: {
  reason: string | null;
  onDismiss?: () => void;
}) {
  return (
    <div role="alert" className="mt-2 rounded-md border border-danger px-3 py-2 text-sm">
      <p className="text-danger">{blockedNotice(reason)}</p>
      <p className="mt-1">
        Refused messages are listed for our moderation team without their text. See the{" "}
        <Link href="/conduct" className="underline" target="_blank">
          conduct rules<span className="sr-only"> (opens in a new tab)</span>
        </Link>
        .{" "}
        {onDismiss && (
          <button type="button" className="underline" onClick={onDismiss}>
            Dismiss
          </button>
        )}
      </p>
    </div>
  );
}
