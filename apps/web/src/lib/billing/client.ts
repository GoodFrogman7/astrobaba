import type { ApiErrorBody, WalletResponse } from "./types";

/** Browser-side calls to our own route handlers (never to the API directly). */
export type CallResult<T> =
  { ok: true; status: number; data: T } | { ok: false; status: number; error: ApiErrorBody };

export async function call<T>(
  url: string,
  init: { method?: "GET" | "POST"; body?: unknown; idempotencyKey?: string } = {},
): Promise<CallResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      cache: "no-store",
      headers: {
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init.idempotencyKey ? { "idempotency-key": init.idempotencyKey } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    return { ok: false, status: 0, error: { code: "network_error" } };
  }
  let json: unknown = {};
  try {
    json = await res.json();
  } catch {
    /* empty */
  }
  if (res.ok) return { ok: true, status: res.status, data: json as T };
  const err = (json && typeof json === "object" ? json : {}) as ApiErrorBody;
  return { ok: false, status: res.status, error: { ...err, code: err.code ?? "unexpected_error" } };
}

/**
 * The wallet is read by the header link, the consult card and the wallet page at once; one
 * request serves them all, and `refreshWallet()` tells every reader about the new balance.
 */
type Listener = (w: WalletResponse | null) => void;
const listeners = new Set<Listener>();
let inflight: Promise<WalletResponse | null> | null = null;
let last: { at: number; value: WalletResponse | null } | null = null;
const FRESH_MS = 10_000;

export function loadWallet(force = false): Promise<WalletResponse | null> {
  if (!force && last && Date.now() - last.at < FRESH_MS) return Promise.resolve(last.value);
  if (!force && inflight) return inflight;
  const p = call<WalletResponse>("/api/wallet").then((r) => {
    const value = r.ok ? r.data : null;
    last = { at: Date.now(), value };
    if (inflight === p) inflight = null;
    for (const l of listeners) l(value);
    return value;
  });
  inflight = p;
  return p;
}

export function refreshWallet(): Promise<WalletResponse | null> {
  return loadWallet(true);
}

export function onWallet(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
