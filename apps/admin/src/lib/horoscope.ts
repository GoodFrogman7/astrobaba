import { AREAS, type Sections } from "./types";

export interface ApprovePayload {
  reviewer: string;
  sections?: Sections;
}

/**
 * Body for POST /v1/admin/horoscopes/{id}/approve. Edited text is sent only when something
 * changed, and then for all five areas (the API re-validates the full set).
 */
export function approvePayload(
  original: Sections,
  edited: Partial<Record<string, FormDataEntryValue | null>>,
  reviewer: string,
): ApprovePayload {
  const sections = Object.fromEntries(
    AREAS.map((a) => {
      const v = edited[a];
      return [a, typeof v === "string" ? v.replace(/\r\n/g, "\n").trim() : original[a]];
    }),
  ) as Sections;
  const changed = AREAS.some((a) => sections[a] !== original[a].trim());
  return changed ? { reviewer: reviewer.trim(), sections } : { reviewer: reviewer.trim() };
}
