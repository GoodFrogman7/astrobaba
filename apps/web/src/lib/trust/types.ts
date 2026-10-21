/** Shapes of GET /v1/legal (docs/api/trust.md §1), read from data/legal/policies.json by the API. */
export interface Processor {
  id: string;
  purpose: string;
  data: string;
  region?: string | null;
  /** Set while the founder has not named the provider yet (e.g. "provider name (e.g. MSG91)"). */
  founder_to_fill?: string | boolean | null;
}

export interface LegalInfo {
  version: string;
  status: string;
  documents: string[];
  operator: { legal_name: string | null; address: string | null };
  grievance_officer: { name: string | null; email: string | null; note?: string | null };
  processors: Processor[];
  retention: { proposed?: Record<string, string> | null } & Record<string, unknown>;
}

/** Policies are drafts until a lawyer approves a version (status `draft_…`). */
export function isDraft(status: string): boolean {
  return status !== "approved";
}

/** GET /v1/me (docs/api/marketplace.md): the phone arrives masked. */
export interface Me {
  id: string;
  phone: string;
  locale: string | null;
  is_adult_confirmed?: boolean;
  created_at?: string;
  roles: string[];
  astrologer: { id: string; status: string; slug: string } | null;
}

/** GET /v1/me/deletion (docs/api/trust.md §2). */
export interface DeletionRequest {
  id: string;
  status: string;
  requested_at?: string;
  created_at?: string;
  [extra: string]: unknown;
}
