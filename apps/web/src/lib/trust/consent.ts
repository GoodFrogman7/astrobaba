import { CONSENT_KINDS, type ConsentKind, type ConsentState } from "@astro/shared";

/**
 * Age gate and consent (docs/api/trust.md §1). Users accept `age_18`, `terms` and `privacy` at
 * the current policy version; `astrologer_terms` belongs to the astrologer portal.
 *
 * Any money, consultation, report, AI or remedy request may answer `403 consent_required`. The
 * browser client (`lib/billing/client.ts`) then asks the one consent step that is mounted in
 * the layout (`ConsentGate`) and, once the user accepts, sends the request again. The step is
 * a single shared promise, so several requests refused at once open one dialog, not several.
 */
export const USER_CONSENT_KINDS: readonly ConsentKind[] = ["age_18", "terms", "privacy"];

/** GET /api/me/consents: signed out is an expected state, not an error. */
export type ConsentsResponse = { signed_in: false } | ({ signed_in: true } & ConsentState);

export type ConsentHandler = (missing: ConsentKind[]) => Promise<boolean>;

let handler: ConsentHandler | null = null;
let inflight: Promise<boolean> | null = null;

/** Register the consent step (one per page); returns the unregister function. */
export function setConsentHandler(h: ConsentHandler): () => void {
  handler = h;
  return () => {
    if (handler === h) handler = null;
  };
}

/**
 * Ask for consent. Resolves true when the user's consents are current (accepted now or
 * already), false when they closed the step or no step is mounted (then the caller shows the
 * original error).
 */
export function requestConsent(missing: ConsentKind[] = []): Promise<boolean> {
  if (!handler) return Promise.resolve(false);
  inflight ??= handler(missing)
    .catch(() => false)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function isConsentRequired(status: number, error: { code?: unknown }): boolean {
  return status === 403 && error.code === "consent_required";
}

/** The `missing` kinds of a `consent_required` error, limited to known kinds. */
export function missingKinds(error: Record<string, unknown>): ConsentKind[] {
  const raw = Array.isArray(error.missing) ? error.missing : [];
  return raw.filter((k): k is ConsentKind => CONSENT_KINDS.includes(k as ConsentKind));
}

/**
 * The kinds this web step asks for: the user kinds the API requires that are not yet accepted
 * at the current version. If the API says consents are not current but every kind looks
 * accepted (e.g. a field we do not know about), all three are asked again; re-accepting is
 * harmless because the consent log is append-only.
 */
export function kindsToAsk(state: ConsentState, missing: ConsentKind[] = []): ConsentKind[] {
  const required = state.required.length ? state.required : [...USER_CONSENT_KINDS];
  const accepted = new Set(
    state.accepted.filter((a) => a.version === state.version).map((a) => a.kind),
  );
  // GET /v1/me/consents also lists `missing` (not in the shared type yet).
  const listed = missingKinds(state as unknown as Record<string, unknown>);
  const ask = USER_CONSENT_KINDS.filter(
    (k) => (required.includes(k) || missing.includes(k) || listed.includes(k)) && !accepted.has(k),
  );
  return ask.length || state.current ? ask : [...USER_CONSENT_KINDS];
}

export interface ConsentChoice {
  adult: boolean;
  terms: boolean;
}

export type ConsentFormError = "age" | "terms";

/** Both boxes start unticked and must be ticked by the user (no pre-ticked consent). */
export function validateConsent(kinds: ConsentKind[], choice: ConsentChoice): ConsentFormError[] {
  const errors: ConsentFormError[] = [];
  if (kinds.includes("age_18") && !choice.adult) errors.push("age");
  if ((kinds.includes("terms") || kinds.includes("privacy")) && !choice.terms) errors.push("terms");
  return errors;
}

type Result<T> =
  { ok: true; status: number; data: T } | { ok: false; status: number; error: { code: string } };
export type Fetcher = <T>(
  url: string,
  init?: { method?: "GET" | "POST" | "DELETE"; body?: unknown },
) => Promise<Result<T>>;

export type AcceptOutcome =
  | { kind: "accepted"; state: ConsentState }
  | { kind: "stale"; state: ConsentState | null }
  | { kind: "signin" }
  | { kind: "error"; key: "network" | "generic" };

/**
 * POST /api/me/consents with the version the user read. A newer version published meanwhile
 * (`409 consent_version_stale`) re-reads the state so the user sees and accepts the new one.
 */
export async function acceptConsents(
  version: string,
  kinds: ConsentKind[],
  fetcher: Fetcher,
): Promise<AcceptOutcome> {
  const r = await fetcher<ConsentState>("/api/me/consents", {
    method: "POST",
    body: { version, kinds },
  });
  if (r.ok) return { kind: "accepted", state: r.data };
  if (r.status === 401) return { kind: "signin" };
  if (r.status === 409 && r.error.code === "consent_version_stale") {
    const again = await fetcher<ConsentsResponse>("/api/me/consents");
    return {
      kind: "stale",
      state: again.ok && again.data.signed_in ? stripSignedIn(again.data) : null,
    };
  }
  return { kind: "error", key: r.status === 0 ? "network" : "generic" };
}

export function stripSignedIn(r: { signed_in: true } & ConsentState): ConsentState {
  return {
    version: r.version,
    required: r.required,
    missing: r.missing,
    accepted: r.accepted,
    current: r.current,
  };
}

/** Session-scoped "not now" for the reminder shown on page load (the 403 step still opens). */
const DISMISS_KEY = "astro:consent-later";

export function dismissedThisSession(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function rememberDismissed(): void {
  try {
    sessionStorage.setItem(DISMISS_KEY, "1");
  } catch {
    /* storage blocked: the reminder may show again, which is harmless */
  }
}
