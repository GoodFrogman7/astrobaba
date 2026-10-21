import type { Parsed } from "./money-admin";

/**
 * Remedies partner leads (docs/api/revenue.md §4). The API masks the phone in every admin view
 * and never returns the user's note (it goes to the partner only).
 */

export const LEAD_STATUSES = ["new", "contacted", "closed", "spam"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** Statuses an admin can set (a lead starts as `new`). */
export const LEAD_TARGETS = ["contacted", "closed", "spam"] as const;
export type LeadTarget = (typeof LEAD_TARGETS)[number];

export const LEAD_NOTE_MAX = 500;

export interface AdminLead {
  id: string;
  user_id: string;
  remedy_id: string;
  remedy_name: { en: string; hi: string } | null;
  partner_id: string;
  language: "en" | "hi";
  preferred_date: string | null;
  phone_masked: string;
  has_note: boolean;
  status: LeadStatus;
  admin_note: string | null;
  status_changed_at: string | null;
  notified_at: string | null;
  created_at: string;
}

export const LEAD_STATUS_LABEL: Record<LeadStatus, string> = {
  new: "New",
  contacted: "Contacted",
  closed: "Closed",
  spam: "Spam",
};

/** A status filter from the query string; anything else means "all". */
export function leadStatusFilter(input: string | undefined): LeadStatus | null {
  return (LEAD_STATUSES as readonly string[]).includes(input ?? "") ? (input as LeadStatus) : null;
}

export function parseLeadUpdate(fields: {
  status: string;
  note: string;
}): Parsed<{ status: LeadTarget; note: string }> {
  if (!(LEAD_TARGETS as readonly string[]).includes(fields.status)) {
    return { ok: false, error: "Choose contacted, closed or spam." };
  }
  const note = fields.note.trim();
  if (note.length > LEAD_NOTE_MAX) {
    return { ok: false, error: `Keep the note under ${LEAD_NOTE_MAX} characters.` };
  }
  return { ok: true, value: { status: fields.status as LeadTarget, note } };
}

/** Never show a full phone number, even if an API change ever sent one. */
export function safePhone(masked: string): string {
  return /^\+?\d{8,}$/.test(masked) ? `${masked.slice(0, 3)}•••••${masked.slice(-5)}` : masked;
}

export function leadErrorText(code: string): string | undefined {
  if (code === "not_found") return "This lead no longer exists.";
  return undefined;
}
