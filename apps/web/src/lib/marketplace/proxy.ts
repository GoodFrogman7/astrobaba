import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { sessionToken } from "@/lib/tools/proxy";
import { relay } from "@/lib/billing/forward";
import { API_URL } from "@/lib/upstream";
import { checkUploadHeaders, limitStream, MAX_BODY_BYTES } from "./upload";

/**
 * Forward a JSON request for the signed-in user to the API and relay status + body. Personal
 * data stays in bodies; nothing is logged.
 */
export async function forwardJson(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<NextResponse> {
  const token = await sessionToken();
  if (!token) return NextResponse.json({ code: "not_signed_in" }, { status: 401 });
  try {
    const res = await fetch(API_URL + path, {
      method,
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return relay(res);
  } catch {
    return NextResponse.json({ code: "upstream_unavailable" }, { status: 503 });
  }
}

/** Stream a multipart upload to the API without buffering it on disk. */
export async function forwardUpload(req: NextRequest, path: string): Promise<NextResponse> {
  const token = await sessionToken();
  if (!token) return NextResponse.json({ code: "not_signed_in" }, { status: 401 });
  const check = checkUploadHeaders(
    req.headers.get("content-type"),
    req.headers.get("content-length"),
  );
  if (!check.ok) return NextResponse.json({ code: check.code }, { status: check.status });
  if (!req.body) return NextResponse.json({ code: "empty_body" }, { status: 400 });
  try {
    const res = await fetch(API_URL + path, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(60000),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": req.headers.get("content-type") ?? "",
      },
      body: limitStream(req.body, MAX_BODY_BYTES),
      // Required by Node's fetch to send a streaming body.
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    return relay(res);
  } catch (e) {
    const tooBig = e instanceof Error && /file_too_large/.test(String(e.cause ?? e.message));
    return NextResponse.json(
      { code: tooBig ? "file_too_large" : "upstream_unavailable" },
      { status: tooBig ? 413 : 503 },
    );
  }
}
