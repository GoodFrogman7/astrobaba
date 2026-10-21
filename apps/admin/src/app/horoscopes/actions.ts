"use server";

import { cookies } from "next/headers";
import { adminAction, field } from "@/lib/actions-common";
import { api } from "@/lib/api";
import { REVIEWER_COOKIE } from "@/lib/cookies";
import { approvePayload } from "@/lib/horoscope";
import type { ActionResult } from "@/lib/result";
import { AREAS, type Sections } from "@/lib/types";

const enc = encodeURIComponent;

async function reviewer(form: FormData): Promise<string | null> {
  const name = field(form, "reviewer");
  if (name.length < 2) return null;
  (await cookies()).set(REVIEWER_COOKIE, name.slice(0, 80), {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: 180 * 24 * 3600,
  });
  return name.slice(0, 80);
}

export async function approveHoroscope(
  id: string,
  original: Sections,
  _: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const name = await reviewer(form);
  if (!name) return { ok: false, error: "Enter your name as reviewer." };
  const edited = Object.fromEntries(AREAS.map((a) => [a, form.get(a)]));
  const body = approvePayload(original, edited, name);
  return adminAction(
    ["/horoscopes", "/"],
    () => api.post(`/v1/admin/horoscopes/${enc(id)}/approve`, body),
    body.sections ? "Published with your edits." : "Published.",
  );
}

export async function rejectHoroscope(
  id: string,
  _: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const name = await reviewer(form);
  if (!name) return { ok: false, error: "Enter your name as reviewer." };
  const reason = field(form, "reason");
  if (reason.length < 3) return { ok: false, error: "A reason is required." };
  return adminAction(
    ["/horoscopes", "/"],
    () => api.post(`/v1/admin/horoscopes/${enc(id)}/reject`, { reviewer: name, reason }),
    "Rejected.",
  );
}
