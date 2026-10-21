import "server-only";

import { cookies } from "next/headers";
import { SESSION_COOKIE } from "./cookies";
import type { Me } from "./types";

const API_URL = (process.env.API_URL ?? "http://localhost:8000").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public errors: string[] = [],
  ) {
    super(message);
  }
}

export async function token(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

/** Raw call to the core API with the admin's session token. Never cached. */
export async function apiFetch(
  path: string,
  init: RequestInit = {},
  auth?: string,
): Promise<Response> {
  const t = auth ?? (await token());
  try {
    return await fetch(API_URL + path, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
      headers: {
        ...(init.body && !(init.body instanceof FormData)
          ? { "content-type": "application/json" }
          : {}),
        ...(t ? { authorization: `Bearer ${t}` } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new ApiError(503, "api_unavailable", "The API is unreachable.");
  }
}

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let code = "api_error";
    let message = res.statusText;
    let errors: string[] = [];
    try {
      const body = (await res.json()) as {
        detail?: { code?: string; message?: string; errors?: string[] } | unknown;
      };
      const d = body.detail;
      if (d && typeof d === "object" && !Array.isArray(d)) {
        const det = d as { code?: string; message?: string; errors?: string[] };
        code = det.code ?? code;
        message = det.message ?? message;
        errors = det.errors ?? [];
      } else if (Array.isArray(d)) {
        code = "validation_error";
        message = d.map((e: { msg?: string }) => e.msg ?? "").join("; ");
      }
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, code, message, errors);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: async <T>(path: string) => parse<T>(await apiFetch(path)),
  post: async <T>(path: string, body?: unknown, auth?: string) =>
    parse<T>(
      await apiFetch(
        path,
        { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) },
        auth,
      ),
    ),
  patch: async <T>(path: string, body: unknown) =>
    parse<T>(await apiFetch(path, { method: "PATCH", body: JSON.stringify(body) })),
};

/** The signed-in user, or null (no cookie, expired or revoked session, API down). */
export async function fetchMe(): Promise<Me | null> {
  if (!(await token())) return null;
  try {
    return await api.get<Me>("/v1/me");
  } catch {
    return null;
  }
}
