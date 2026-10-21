/** Review list helpers for the portal (docs/api/portal.md §2.4, marketplace.md reviews). */
import type { PortalReview } from "./types";

/** Same as the API's limit (data/marketplace/taxonomy.json `review.max_text_chars`). */
export const REPLY_MAX_CHARS = 1000;

export type ReviewFilter = "all" | "unreplied";

export function reviewFilter(v: string | undefined): ReviewFilter {
  return v === "unreplied" ? "unreplied" : "all";
}

/** Held reviews are not public yet and cannot be replied to until a moderator publishes them. */
export function reviewStatus(status: PortalReview["status"]): {
  label: string;
  held: boolean;
  note: string | null;
} {
  if (status === "published") return { label: "Published", held: false, note: null };
  return {
    label: "Held for moderation",
    held: true,
    note: "Not shown on your profile. A moderator will publish or remove it.",
  };
}

/** "★★★★☆" for display; screen readers get the text alternative from `ratingLabel`. */
export function stars(rating: number): string {
  const r = Math.max(0, Math.min(5, Math.round(rating)));
  return "★".repeat(r) + "☆".repeat(5 - r);
}

export function ratingLabel(rating: number): string {
  return `${Math.max(0, Math.min(5, Math.round(rating)))} out of 5 stars`;
}

const REPLY_ERRORS: Record<string, string> = {
  already_replied: "You have already replied to this review. Replies are final.",
  text_too_long: "The reply is too long. Keep it under 1,000 characters.",
  empty_reply: "Write a reply first.",
  reply_not_allowed:
    "Replies cannot contain contact details, abusive language or promises about outcomes. Please rephrase.",
  not_found: "This review can't be replied to right now (it may be held for moderation).",
  api_unavailable: "The service is unreachable. Try again in a moment.",
};

export function replyErrorText(code: string | undefined, message?: string): string {
  return (code && REPLY_ERRORS[code]) || message || "The reply was not saved. Try again.";
}
