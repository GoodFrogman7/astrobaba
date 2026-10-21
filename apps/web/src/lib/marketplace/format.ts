/** Small display helpers. Formatting happens at the edge with an explicit zone. */

/**
 * Money in integer paise as rupees: "₹500" for whole rupees, "₹12.50" otherwise. `signed` adds
 * "+" for credits and "−" for debits (wallet transactions are signed from the user's view).
 */
export function formatPaise(
  paise: number,
  locale: "en" | "hi",
  { signed = false }: { signed?: boolean } = {},
): string {
  const abs = Math.abs(Math.trunc(paise));
  const r = abs / 100;
  const s = new Intl.NumberFormat(locale === "hi" ? "hi-IN" : "en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: abs % 100 === 0 ? 0 : 2,
    maximumFractionDigits: abs % 100 === 0 ? 0 : 2,
  }).format(r);
  if (!signed || paise === 0) return paise < 0 ? `\u2212${s}` : s;
  return paise > 0 ? `+${s}` : `\u2212${s}`;
}

export function rupeesPerMin(paise: number, locale: "en" | "hi"): string {
  return formatPaise(paise, locale);
}

/** Date and time in IST, e.g. "21 Oct 2026, 6:30 pm". */
export function dateTimeIst(iso: string, locale: "en" | "hi"): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(locale === "hi" ? "hi-IN" : "en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  }).format(d);
}

/** Elapsed seconds as "m:ss" (or "h:mm:ss" past an hour). */
export function clock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0] ?? "", parts[parts.length - 1] ?? ""] : parts;
  return letters.map((w) => (Array.from(w)[0] ?? "").toUpperCase()).join("") || "?";
}

export function monthYear(ym: string, locale: "en" | "hi"): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 15));
  return new Intl.DateTimeFormat(locale === "hi" ? "hi-IN" : "en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(d);
}

export function shortDate(iso: string, locale: "en" | "hi"): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(locale === "hi" ? "hi-IN" : "en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  }).format(d);
}

export function ratingText(average: number | null): string | null {
  return average === null ? null : average.toFixed(1);
}
