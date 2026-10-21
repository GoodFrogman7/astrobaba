/** Cookie names and flags for the optional sign-in (OTP) used by "Save my kundli". */
export const SESSION_COOKIE = "ap_session";
export const DEVICE_COOKIE = "ap_device";

export interface CookieFlags {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
}

/** The session token is readable only by the server (httpOnly), never by page scripts. */
export function sessionCookieFlags(isHttps: boolean, expiresAt?: string): CookieFlags {
  const maxAge = expiresAt
    ? Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000))
    : 30 * 24 * 3600;
  return { httpOnly: true, secure: isHttps, sameSite: "lax", path: "/", maxAge };
}

/** Random first-party device id used for abuse limits on OTP requests. */
export function deviceCookieFlags(isHttps: boolean): CookieFlags {
  return { httpOnly: true, secure: isHttps, sameSite: "lax", path: "/", maxAge: 365 * 24 * 3600 };
}

export function isHttps(url: string, forwardedProto: string | null): boolean {
  return (forwardedProto ?? new URL(url).protocol.replace(":", "")) === "https";
}

export function newDeviceId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}
