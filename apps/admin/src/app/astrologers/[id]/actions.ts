"use server";

import { field, adminAction } from "@/lib/actions-common";
import { api } from "@/lib/api";
import { checkPrice } from "@/lib/money";
import type { ActionResult } from "@/lib/result";
import { STEPS, type Step, type Taxonomy } from "@/lib/types";

const paths = (id: string) => [`/astrologers/${id}`, "/astrologers", "/"];
const enc = encodeURIComponent;

export async function recordStep(
  id: string,
  step: Step,
  _: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  if (!STEPS.includes(step)) return { ok: false, error: "Unknown step." };
  const status = field(form, "status");
  if (status !== "passed" && status !== "failed")
    return { ok: false, error: "Choose pass or fail." };
  const note = field(form, "note");
  if (status === "failed" && note.length < 3) return { ok: false, error: "Say why it failed." };
  return adminAction(
    paths(id),
    () => api.post(`/v1/admin/astrologers/${enc(id)}/verifications/${step}`, { status, note }),
    `${step} marked ${status}.`,
  );
}

async function priceFromForm(form: FormData) {
  const taxonomy = await api.get<Taxonomy>("/v1/taxonomy");
  const tier = taxonomy.tiers.find((t) => t.id === field(form, "tier"));
  return { tier, check: checkPrice(field(form, "price_rupees"), tier) };
}

export async function approve(
  id: string,
  _: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const { tier, check } = await priceFromForm(form);
  if (!check.ok) return { ok: false, error: check.error };
  return adminAction(
    paths(id),
    () =>
      api.post(`/v1/admin/astrologers/${enc(id)}/approve`, {
        tier: tier!.id,
        price_per_min_paise: check.paise,
      }),
    "Approved: now live on probation.",
  );
}

export async function updateTierPrice(
  id: string,
  _: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const { tier, check } = await priceFromForm(form);
  if (!check.ok) return { ok: false, error: check.error };
  return adminAction(paths(id), () =>
    api.patch(`/v1/admin/astrologers/${enc(id)}`, {
      tier: tier!.id,
      price_per_min_paise: check.paise,
    }),
  );
}

export async function updateFlags(
  id: string,
  _: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const flags = {
    chat_enabled: form.get("chat_enabled") === "on",
    call_enabled: form.get("call_enabled") === "on",
    show_in_directory: form.get("show_in_directory") === "on",
  };
  return adminAction(paths(id), () => api.patch(`/v1/admin/astrologers/${enc(id)}`, { flags }));
}

function reasoned(kind: "suspend" | "reject") {
  return async (id: string, _: ActionResult | null, form: FormData): Promise<ActionResult> => {
    const reason = field(form, "reason");
    if (reason.length < 3) return { ok: false, error: "A reason is required." };
    return adminAction(paths(id), () =>
      api.post(`/v1/admin/astrologers/${enc(id)}/${kind}`, { reason }),
    );
  };
}

export const suspend = reasoned("suspend");
export const reject = reasoned("reject");

export async function reinstate(id: string): Promise<ActionResult> {
  return adminAction(paths(id), () => api.post(`/v1/admin/astrologers/${enc(id)}/reinstate`, {}));
}
