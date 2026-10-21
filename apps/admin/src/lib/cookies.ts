export const SESSION_COOKIE = "ap_admin_session";
export const DEVICE_COOKIE = "ap_admin_device";
export const REVIEWER_COOKIE = "ap_admin_reviewer";

export const ADMIN_SESSION_MAX_S = 12 * 3600;

/**
 * The admin session is server-only (httpOnly), never sent cross-site (Strict) and short-lived:
 * at most 12 hours, even when the API token lives longer.
 */
export function sessionCookieFlags(isHttps: boolean, expiresAt?: string) {
  const untilExpiry = expiresAt
    ? Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000))
    : ADMIN_SESSION_MAX_S;
  const maxAge = Math.min(untilExpiry, ADMIN_SESSION_MAX_S);
  return { httpOnly: true, secure: isHttps, sameSite: "strict" as const, path: "/", maxAge };
}

export function isHttps(url: string, forwardedProto: string | null): boolean {
  return (forwardedProto ?? new URL(url).protocol.replace(":", "")) === "https";
}
