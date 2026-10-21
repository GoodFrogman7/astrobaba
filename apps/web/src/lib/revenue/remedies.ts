import type { ReportLanguage } from "@astro/shared";
import { REMEDY_NOTE_MAX } from "./config";

export interface LeadInput {
  remedyId: string;
  preferredDate: string;
  language: ReportLanguage;
  note: string;
  consent: boolean;
}

export type LeadError = "consent" | "note" | "date";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Before sending a partner request: consent is required (unticked by default), the note is at
 * most 500 characters, and a preferred date, if given, is a real date from today (IST) on.
 */
export function validateLead(l: LeadInput, todayIst: string): LeadError[] {
  const errors: LeadError[] = [];
  if (l.consent !== true) errors.push("consent");
  if (Array.from(l.note).length > REMEDY_NOTE_MAX) errors.push("note");
  if (l.preferredDate) {
    const d = new Date(`${l.preferredDate}T00:00:00Z`);
    if (
      !ISO_DATE.test(l.preferredDate) ||
      Number.isNaN(d.getTime()) ||
      d.toISOString().slice(0, 10) !== l.preferredDate ||
      l.preferredDate < todayIst
    )
      errors.push("date");
  }
  return errors;
}

/** POST /v1/remedies/leads body (docs/api/revenue.md §4). */
export function leadBody(l: LeadInput) {
  const note = l.note.trim();
  return {
    remedy_id: l.remedyId,
    language: l.language,
    consent: true as const,
    ...(l.preferredDate ? { preferred_date: l.preferredDate } : {}),
    ...(note ? { note } : {}),
  };
}
