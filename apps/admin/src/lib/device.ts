import "server-only";

import { cookies } from "next/headers";
import { DEVICE_COOKIE } from "./cookies";

/** Random first-party device id for the API's OTP rate limits. */
export async function deviceId(): Promise<{ id: string; isNew: boolean }> {
  const existing = (await cookies()).get(DEVICE_COOKIE)?.value;
  if (existing && /^[a-f0-9]{32}$/.test(existing)) return { id: existing, isNew: false };
  return { id: crypto.randomUUID().replace(/-/g, ""), isNew: true };
}
