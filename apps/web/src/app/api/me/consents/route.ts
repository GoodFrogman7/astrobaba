import { CONSENT_KINDS, type ConsentKind } from "@astro/shared";
import { NextResponse, type NextRequest } from "next/server";
import { forward, invalidBody, readJson } from "@/lib/billing/forward";
import { sessionToken } from "@/lib/tools/proxy";

/**
 * Age gate and consents (docs/api/trust.md §1). Signed out is an expected state (the consent
 * step checks on page load), so GET answers 200 `{signed_in: false}` instead of an error.
 */
export async function GET(req: NextRequest) {
  if (!(await sessionToken())) return NextResponse.json({ signed_in: false });
  const res = await forward(req, { method: "GET", path: "/v1/me/consents" });
  if (res.status === 401) return NextResponse.json({ signed_in: false });
  if (!res.ok) return res;
  const out = NextResponse.json({ signed_in: true, ...(await res.json()) });
  for (const c of res.cookies.getAll()) out.cookies.set(c);
  return out;
}

const VERSION = /^[A-Za-z0-9._-]{1,64}$/;

/** Accept consents at the version the user read: `{version, kinds}`. */
export async function POST(req: NextRequest) {
  const body = await readJson(req);
  if (!body) return invalidBody();
  const { version, kinds } = body;
  if (typeof version !== "string" || !VERSION.test(version))
    return NextResponse.json({ code: "invalid_version" }, { status: 422 });
  if (
    !Array.isArray(kinds) ||
    kinds.length === 0 ||
    kinds.length > CONSENT_KINDS.length ||
    !kinds.every((k) => CONSENT_KINDS.includes(k as ConsentKind)) ||
    new Set(kinds).size !== kinds.length
  )
    return NextResponse.json({ code: "invalid_kinds" }, { status: 422 });
  return forward(req, { method: "POST", path: "/v1/me/consents", body: { version, kinds } });
}
