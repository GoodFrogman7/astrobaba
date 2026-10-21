export const SESSION_COOKIE = "ap_astro_session";
export const DEVICE_COOKIE = "ap_astro_device";

export const CONSOLE_SESSION_MAX_S = 12 * 3600;

/**
 * The console session is server-only (httpOnly), never sent cross-site (Strict) and lasts at most
 * 12 hours (one working day), even when the API token lives longer.
 */
export function sessionCookieFlags(isHttps: boolean, expiresAt?: string) {
  const untilExpiry = expiresAt
    ? Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000))
    : CONSOLE_SESSION_MAX_S;
  const maxAge = Math.min(untilExpiry, CONSOLE_SESSION_MAX_S);
  return { httpOnly: true, secure: isHttps, sameSite: "strict" as const, path: "/", maxAge };
}

export function isHttps(url: string, forwardedProto: string | null): boolean {
  return (forwardedProto ?? new URL(url).protocol.replace(":", "")) === "https";
}
