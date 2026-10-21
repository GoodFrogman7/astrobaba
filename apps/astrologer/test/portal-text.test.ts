import { describe, expect, it } from "vitest";
import { callToggle, consultErrorText, tierLabel } from "../src/lib/consult";
import { endReasonText } from "../src/lib/format";
import { ratingLabel, replyErrorText, reviewFilter, reviewStatus, stars } from "../src/lib/reviews";

describe("review helpers", () => {
  it("reads the filter safely", () => {
    expect(reviewFilter("unreplied")).toBe("unreplied");
    expect(reviewFilter("all")).toBe("all");
    expect(reviewFilter("removed")).toBe("all");
    expect(reviewFilter(undefined)).toBe("all");
  });

  it("labels published, reported and held reviews", () => {
    expect(reviewStatus("published")).toEqual({ label: "Published", held: false, note: null });
    expect(reviewStatus("flagged")).toMatchObject({ label: "Reported", held: false });
    expect(reviewStatus("held")).toMatchObject({ label: "Held for moderation", held: true });
    expect(reviewStatus("pending_moderation").held).toBe(true);
  });

  it("shows stars with a text alternative", () => {
    expect(stars(4)).toBe("★★★★☆");
    expect(stars(9)).toBe("★★★★★");
    expect(ratingLabel(3)).toBe("3 out of 5 stars");
  });

  it("explains reply errors in plain words, including that replies are final", () => {
    expect(replyErrorText("already_replied")).toMatch(/final/);
    expect(replyErrorText("reply_not_allowed")).toMatch(/contact details/);
    expect(replyErrorText("other", "Server said no")).toBe("Server said no");
    expect(replyErrorText(undefined)).toMatch(/not saved/);
  });
});

describe("consultation settings", () => {
  const s = (
    o: Partial<{ chat_enabled: boolean; call_enabled: boolean; voice_calls_available: boolean }>,
  ) => ({
    chat_enabled: true,
    call_enabled: false,
    voice_calls_available: true,
    ...o,
  });

  it("disables turning calls on while the platform switch is off or the API refused", () => {
    expect(callToggle(s({}), false)).toEqual({ disabled: false, reason: null });
    expect(callToggle(s({ voice_calls_available: false }), false).disabled).toBe(true);
    expect(callToggle(s({}), true).disabled).toBe(true);
    // Turning calls off always stays possible.
    const on = callToggle(s({ call_enabled: true, voice_calls_available: false }), false);
    expect(on.disabled).toBe(false);
    expect(on.reason).toMatch(/switched off/);
  });

  it("maps errors and tiers to plain words", () => {
    expect(consultErrorText("call_unavailable")).toMatch(/switched off/);
    expect(consultErrorText(undefined)).toMatch(/not saved/);
    expect(tierLabel("senior_expert")).toBe("Senior expert");
    expect(tierLabel(null)).toBe("Not set");
  });
});

describe("end reasons for calls", () => {
  it("say call instead of chat", () => {
    expect(endReasonText("astrologer_ended", "call")).toBe("You ended the call.");
    expect(endReasonText(null, "call")).toBe("The call has ended.");
    expect(endReasonText("astrologer_ended")).toBe("You ended the chat.");
  });
});
