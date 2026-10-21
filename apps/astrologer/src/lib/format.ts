import { IST } from "@astro/shared";

/** Display only: money stays integer paise everywhere else. */
export function formatRupees(paise: number): string {
  const sign = paise < 0 ? "−" : "";
  const abs = Math.abs(Math.trunc(paise));
  const rupees = Math.floor(abs / 100);
  const rest = abs % 100;
  return `${sign}₹${rupees.toLocaleString("en-IN")}${rest ? `.${String(rest).padStart(2, "0")}` : ""}`;
}

export function formatRate(paisePerMin: number): string {
  return `${formatRupees(paisePerMin)}/min`;
}

/** Elapsed time as m:ss or h:mm:ss. Negative input (clock skew) shows 0:00. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** "just now", "45 s", "3 min", "1 h 5 min": how long a request has been waiting. */
export function formatWaiting(fromIso: string, now: number): string {
  const ms = now - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 5000) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function minutesLabel(n: number): string {
  return `${n} min`;
}

/** Date and time in IST, the product's single display zone. */
export function formatIst(iso: string | null): string {
  if (!iso) return "–";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "–";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: IST,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

/** Tab title with a count of waiting requests, e.g. "(2) Console". */
export function titleWithBadge(base: string, count: number): string {
  return count > 0 ? `(${count}) ${base}` : base;
}

const END_TEXT: Record<string, string> = {
  user_ended: "The client ended the chat.",
  astrologer_ended: "You ended the chat.",
  insufficient_funds: "The client's balance ran out.",
  free_minutes_used: "The free minutes were used up.",
  user_cancelled: "The client cancelled the request.",
  astrologer_declined: "You declined the request.",
  request_timeout: "The request timed out before it was accepted.",
  join_timeout: "The chat did not start in time.",
  user_dropped: "The client's connection dropped.",
  astrologer_dropped: "Your connection dropped.",
  admin: "Ended by the support team.",
};

export function endReasonText(reason: string | null): string {
  return (reason && END_TEXT[reason]) || "The chat has ended.";
}
