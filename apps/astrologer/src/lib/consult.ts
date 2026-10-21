import type { ConsultSettings } from "@astro/shared";

/** Consultation toggle rules (docs/api/portal.md §2.2). */

export const CALLS_OFF_TEXT =
  "Voice calls are switched off on the platform right now, so you can't turn calls on. Chat is not affected.";

/** Whether the call toggle can be used, and why not. */
export function callToggle(
  s: ConsultSettings,
  refused: boolean,
): { disabled: boolean; reason: string | null } {
  // Turning calls *off* stays possible even when the platform switch is off.
  const off = !s.voice_calls_available || refused;
  if (off && !s.call_enabled) return { disabled: true, reason: CALLS_OFF_TEXT };
  if (off) {
    return {
      disabled: false,
      reason:
        "Voice calls are switched off on the platform right now, so clients can't call you even though your setting is on.",
    };
  }
  return { disabled: false, reason: null };
}

const ERRORS: Record<string, string> = {
  call_unavailable: CALLS_OFF_TEXT,
  not_applied: "This account has no astrologer profile.",
  api_unavailable: "The service is unreachable. Try again in a moment.",
};

export function consultErrorText(code: string | undefined): string {
  return (code && ERRORS[code]) || "The setting was not saved. Try again.";
}

/** "Gold" from "gold", "Senior expert" from "senior_expert". */
export function tierLabel(tier: string | null | undefined): string {
  if (!tier) return "Not set";
  const t = tier.replace(/[_-]+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}
