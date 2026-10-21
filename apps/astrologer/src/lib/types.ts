/** Types for the astrologer console, from docs/api/marketplace.md and docs/api/billing.md. */
import type { SessionView } from "@astro/shared";

export type AstrologerStatus =
  "applied" | "kyc_submitted" | "interview" | "probation" | "approved" | "suspended" | "rejected";

/** `GET /v1/me`. The phone arrives masked and is never shown in the console. */
export interface Me {
  id: string;
  phone?: string;
  locale?: string;
  roles?: string[];
  astrologer: { id: string; status: AstrologerStatus; slug: string | null } | null;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export type SessionPage = Page<SessionView>;
