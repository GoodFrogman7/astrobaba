/** Small display helpers. Formatting happens at the edge with an explicit zone. */
export function rupeesPerMin(paise: number, locale: "en" | "hi"): string {
  const r = paise / 100;
  const s = new Intl.NumberFormat(locale === "hi" ? "hi-IN" : "en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: Number.isInteger(r) ? 0 : 2,
  }).format(r);
  return s;
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
