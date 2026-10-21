import type { ConsentState, Helpline, SafetyResources } from "@astro/shared";

/**
 * Trust and safety helpers for the portal (docs/api/trust.md §1, §3, §4). Pure, so the gate,
 * the blocked-message notice and the safety panel are tested without Next.js or a browser.
 */

/* ---------- Astrologer terms gate (§1) ---------- */

export const TERMS_KIND = "astrologer_terms" as const;

/** Versions are short tokens such as "2026-10-21"; anything else never reaches the API. */
export const CONSENT_VERSION = /^[A-Za-z0-9._-]{1,32}$/;

/**
 * Whether the astrologer still has to accept the astrologer terms: there is no
 * `astrologer_terms` acceptance for the current version.
 */
export function needsAstrologerTerms(state: Pick<ConsentState, "version" | "accepted">): boolean {
  return !state.accepted.some((a) => a.kind === TERMS_KIND && a.version === state.version);
}

export type TermsGate = { gate: false } | { gate: true; version: string };

/**
 * Decide whether a page shows the terms gate. When the consent state cannot be read the console
 * stays open: the API still refuses portal writes with `403 consent_required`, which opens the
 * gate from the page that tried the write.
 */
export async function termsGate(load: () => Promise<ConsentState>): Promise<TermsGate> {
  let state: ConsentState;
  try {
    state = await load();
  } catch {
    return { gate: false };
  }
  if (!state || typeof state.version !== "string" || !Array.isArray(state.accepted)) {
    return { gate: false };
  }
  return needsAstrologerTerms(state) ? { gate: true, version: state.version } : { gate: false };
}

/** The date this version was accepted, for the "already accepted" view. */
export function acceptedAt(state: Pick<ConsentState, "version" | "accepted">): string | null {
  return (
    state.accepted.find((a) => a.kind === TERMS_KIND && a.version === state.version)?.accepted_at ??
    null
  );
}

/** A portal write refused because the astrologer terms are not accepted (403 consent_required). */
export function isConsentRequired(status: number, body: unknown): boolean {
  return (
    status === 403 &&
    !!body &&
    typeof body === "object" &&
    (body as { code?: unknown }).code === "consent_required"
  );
}

/** Where the gate lives; `next` brings the astrologer back to the page that was refused. */
export function termsHref(next?: string | null): string {
  const safe = next && next.startsWith("/") && !next.startsWith("//") ? next : null;
  return safe && safe !== "/terms" ? `/terms?${new URLSearchParams({ next: safe })}` : "/terms";
}

/** Only same-site paths are followed after accepting. */
export function safeNext(next: string | undefined | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return "/";
  }
  return next.slice(0, 200);
}

export type AcceptResult = { ok: true } | { ok: false; error: string; stale?: boolean };

const CONSENT_ERRORS: Record<string, string> = {
  consent_version_stale:
    "The terms were updated while this page was open. Reload the page and read the new version before accepting.",
  signed_out: "You were signed out. Sign in again.",
  api_unavailable: "The service is unreachable. Try again in a moment.",
};

/** POST the acceptance through this app's route handler. `fetchImpl` is injected for tests. */
export async function acceptTerms(
  version: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AcceptResult> {
  let res: Response;
  try {
    res = await fetchImpl("/api/consents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version }),
    });
  } catch {
    return { ok: false, error: "Network error. Try again." };
  }
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
  const code = body.code ?? "";
  return {
    ok: false,
    error: CONSENT_ERRORS[code] ?? "Your acceptance was not saved. Try again.",
    ...(code === "consent_version_stale" ? { stale: true } : {}),
  };
}

/* ---------- Conduct rules (§3, §4) ---------- */

/**
 * The banned-topic list. trust.md §4 says it comes from `data/safety/conduct.json`, but no file
 * or endpoint exists yet, so the portal shows this summary of the contract (§3).
 */
export const CONDUCT_RULES: readonly { id: string; title: string; text: string }[] = [
  {
    id: "health",
    title: "No medical, legal or financial advice",
    text: "Never claim that astrology, a ritual or a remedy can cure or treat an illness. Ask the client to see a doctor, lawyer or adviser for those questions.",
  },
  {
    id: "promises",
    title: "No promised outcomes",
    text: "Never promise that something will certainly happen, such as a marriage, a job or a recovery. Speak about tendencies and choices.",
  },
  {
    id: "fear",
    title: "No fear selling",
    text: "Do not frighten clients about doshas, curses, death or bad luck to make them spend more or stay longer.",
  },
  {
    id: "selling",
    title: "No selling remedies, gemstones or products",
    text: "Do not offer or sell remedies, gemstones, pujas or any product during a consultation.",
  },
  {
    id: "contact",
    title: "No contact details or payments outside the platform",
    text: "Do not share or ask for phone numbers, email addresses, social media handles, UPI ids or bank details. Consultations and payments stay on the platform.",
  },
  {
    id: "crisis",
    title: "Refer a client in crisis to helplines",
    text: "If a client talks about harming themselves, share the crisis helplines the console shows you, do not sell anything, and let them end the session whenever they want.",
  },
];

export const CONDUCT_ENFORCEMENT =
  "Messages with contact details, payment requests, cure or outcome claims, fear selling or product sales are not delivered to the client. Refused messages (without their text) and client reports are reviewed by our team. A warning adds a strike to your record; serious or repeated breaches can lead to suspension.";

/* ---------- Refused messages (§3) ---------- */

/** Reason codes are strings in the contract, not a fixed list: match known words, else generic. */
const BLOCKED: { test: RegExp; text: string }[] = [
  {
    test: /off_platform|payment|upi|bank/,
    text: "it asked for a payment outside the platform",
  },
  {
    test: /contact|phone|email|handle|link/,
    text: "it contained contact details (a phone number, email, social handle or link)",
  },
  {
    test: /cure|medical|health/,
    text: "it claimed that astrology or a remedy can cure an illness",
  },
  { test: /guarant|promise|outcome/, text: "it promised a certain outcome" },
  { test: /fear/, text: "it used fear to persuade the client" },
  {
    test: /remed|gem|product|sale|sell/,
    text: "it offered to sell a remedy, gemstone or product",
  },
];

export function blockedReasonText(reason: string | null | undefined): string {
  const r = (reason ?? "").toLowerCase();
  return BLOCKED.find((b) => b.test.test(r))?.text ?? "it breaks the conduct rules";
}

/** The plain-words line shown next to the composer after `error message_blocked`. */
export function blockedNotice(reason: string | null | undefined): string {
  return `Your message was not sent: ${blockedReasonText(reason)}. The client did not see it.`;
}

/* ---------- Strikes (§4) ---------- */

export interface Strike {
  id: string;
  reason: string | null;
  note: string | null;
  at: string | null;
  session_id: string | null;
}

const REASON_LABEL: Record<string, string> = {
  harassment: "Harassment",
  scam: "Scam",
  fear_selling: "Fear selling",
  medical_claims: "Medical or cure claims",
  off_platform: "Contact or payment outside the platform",
  other: "Other conduct issue",
};

export function strikeReasonLabel(reason: string | null): string {
  if (!reason) return "Conduct warning";
  return REASON_LABEL[reason] ?? reason.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/**
 * `GET /v1/astrologer/me/strikes`. The contract names the endpoint but not the item shape, so
 * read an array or `{items}` and the obvious field names; anything unreadable is skipped.
 */
export function normalizeStrikes(body: unknown): Strike[] {
  const list = Array.isArray(body)
    ? body
    : Array.isArray((body as { items?: unknown } | null)?.items)
      ? (body as { items: unknown[] }).items
      : [];
  const out: Strike[] = [];
  list.forEach((raw, i) => {
    if (!raw || typeof raw !== "object") return;
    const o = raw as Record<string, unknown>;
    const reasons = Array.isArray(o.reasons) ? o.reasons.filter((x) => typeof x === "string") : [];
    out.push({
      id: str(o.id) ?? `strike-${i}`,
      reason: str(o.reason) ?? str(o.reason_code) ?? (reasons[0] as string | undefined) ?? null,
      note: str(o.note),
      at: str(o.created_at) ?? str(o.at) ?? str(o.issued_at),
      session_id: str(o.session_id),
    });
  });
  return out;
}

/* ---------- Crisis resources (§3) ---------- */

/** `GET /v1/safety/resources` (helplines.json). Returns null unless it has usable helplines. */
export function normalizeResources(body: unknown): SafetyResources | null {
  const b = body as { helplines?: unknown; not_a_helpline?: unknown } | null;
  if (!b || !Array.isArray(b.helplines)) return null;
  const helplines = b.helplines.filter(
    (h): h is Helpline =>
      !!h &&
      typeof h === "object" &&
      typeof (h as Helpline).number === "string" &&
      /^[0-9 +-]{2,20}$/.test((h as Helpline).number) &&
      typeof (h as Helpline).name?.en === "string",
  );
  if (helplines.length === 0) return null;
  const nah = b.not_a_helpline as SafetyResources["not_a_helpline"] | undefined;
  return {
    helplines,
    not_a_helpline: {
      en: typeof nah?.en === "string" ? nah.en : "",
      hi: typeof nah?.hi === "string" ? nah.hi : "",
    },
  };
}

/** `tel:` link for a helpline number (digits and a leading + only). */
export function telHref(number: string): string {
  return `tel:${number.replace(/[^0-9+]/g, "")}`;
}

/** Whether a session already raised the safety flag in this tab (survives a reload). */
export const safetyKey = (sessionId: string) => `ap_safety_${sessionId}`;
