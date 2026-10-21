import type { Availability } from "@astro/shared";

/** Shapes from docs/api/marketplace.md. Money is integer paise. */
export type Presence = "online" | "busy" | "offline";
export type Sort = "recommended" | "price_asc" | "price_desc" | "experience" | "rating";

export interface Rating {
  average: number | null;
  count: number;
}

export interface AstrologerCard {
  id: string;
  slug: string;
  display_name: string;
  photo_url: string | null;
  skills: string[];
  languages: string[];
  gender: string;
  tier: string;
  price_per_min_paise: number;
  experience_years: number;
  rating: Rating;
  presence: Presence;
  wait_minutes: number | null;
  is_demo: boolean;
}

export interface AstrologerProfile extends AstrologerCard {
  bio: string;
  bio_hi: string | null;
  verified: { identity: boolean; qualification: boolean; interview: boolean };
  on_platform_since: string; // YYYY-MM
  consult: { chat_enabled: boolean; call_enabled: boolean };
  /** Usual weekly schedule in IST (docs/api/portal.md §2.1); absent or empty → not shown. */
  availability?: Availability | null;
}

export interface ListResponse {
  items: AstrologerCard[];
  next_cursor: string | null;
  total: number;
}

export interface Review {
  id: string;
  rating: number;
  text: string;
  created_at: string;
  author_label: string;
  reply: { text: string; at: string } | null;
}

export interface ReviewsResponse {
  items: Review[];
  next_cursor: string | null;
  rating: Rating;
}

export type VerificationStep = "identity" | "qualification" | "interview" | "probation";
export type ApplicationStatus =
  "applied" | "kyc_submitted" | "interview" | "probation" | "approved" | "suspended" | "rejected";

export interface ApplicantDocument {
  id: string;
  kind: "identity" | "qualification" | "other";
  filename: string;
  size: number;
  uploaded_at: string;
  review_status: string;
}

export interface ApplicantMe {
  id: string;
  slug?: string | null;
  status: ApplicationStatus;
  display_name: string;
  bio: string;
  bio_hi?: string | null;
  skills: string[];
  languages: string[];
  gender: string;
  experience_years: number;
  requested_price_per_min_paise?: number;
  verifications: {
    step: VerificationStep;
    status: "pending" | "passed" | "failed";
    note?: string | null;
    at?: string | null;
  }[];
  documents: ApplicantDocument[];
}

export interface ApplicationInput {
  display_name: string;
  bio: string;
  bio_hi?: string;
  skills: string[];
  languages: string[];
  gender: string;
  experience_years: number;
  requested_price_per_min_paise: number;
  accepts_terms: true;
}
