import { describe, expect, it } from "vitest";
import {
  ACTION_EFFECT,
  asList,
  balanceText,
  canExecute,
  countsText,
  deletionBlockers,
  deletionErrorText,
  deletionFilter,
  deletionStatusLabel,
  itemOutcome,
  itemTime,
  kindFilter,
  moderationErrorText,
  moderationStatusFilter,
  openSessionsText,
  parseModerationAction,
  readFlaggedMessage,
  reasonCodes,
  reasonLabel,
  type DeletionRequest,
} from "../src/lib/trust-admin";

describe("moderation filters and formatting", () => {
  it("reads the tabs safely", () => {
    expect(kindFilter("safety")).toBe("safety");
    expect(kindFilter("refused")).toBe("refused");
    expect(kindFilter("chat")).toBe("report");
    expect(kindFilter(undefined)).toBe("report");
    expect(moderationStatusFilter("closed")).toBe("closed");
    expect(moderationStatusFilter("x")).toBe("open");
  });

  it("collects reason codes from any field, once each", () => {
    expect(
      reasonCodes({
        id: "m",
        reason: "scam",
        reasons: ["scam", "harassment"],
        reason_codes: ["off_platform"],
        safety_kind: "self_harm",
      }),
    ).toEqual(["scam", "harassment", "off_platform", "self_harm"]);
    expect(reasonCodes({ id: "m" })).toEqual([]);
  });

  it("labels reason codes, falling back to readable words", () => {
    expect(reasonLabel("medical_claims")).toBe("Medical or cure claims");
    expect(reasonLabel("self_harm")).toBe("Self-harm language");
    expect(reasonLabel("contact_details")).toBe("Contact details");
    expect(reasonLabel("brand_new_code")).toBe("Brand new code");
  });

  it("formats counts, time and outcome", () => {
    expect(countsText({ id: "m", count: 3 })).toBe("3×");
    expect(countsText({ id: "m", counts: { reports: 2, strikes: 1 } })).toBe(
      "2 reports · 1 strike",
    );
    expect(countsText({ id: "m" })).toBe("–");
    expect(itemTime({ id: "m", created_at: "a", last_at: "b" })).toBe("b");
    expect(itemTime({ id: "m", at: "c" })).toBe("c");
    expect(itemTime({ id: "m" })).toBeNull();
    expect(itemOutcome({ id: "m", resolution: { action: "warn", note: "First warning" } })).toBe(
      "Warned (strike recorded): First warning",
    );
    expect(itemOutcome({ id: "m", action: "dismiss" })).toBe("Dismissed");
    expect(itemOutcome({ id: "m" })).toBeNull();
  });

  it("explains what suspend does before confirming", () => {
    expect(ACTION_EFFECT.suspend).toMatch(/hidden from the directory/);
    expect(ACTION_EFFECT.suspend).toMatch(/until an admin reinstates/);
    expect(ACTION_EFFECT.warn).toMatch(/strike/);
  });

  it("parses the action form", () => {
    expect(parseModerationAction({ action: "warn", note: "  Fear selling  " })).toEqual({
      ok: true,
      value: { action: "warn", note: "Fear selling" },
    });
    expect(parseModerationAction({ action: "warn", note: "ok" }).ok).toBe(false);
    expect(parseModerationAction({ action: "warn", note: "x".repeat(501) }).ok).toBe(false);
    expect(parseModerationAction({ action: "delete", note: "Fear selling" }).ok).toBe(false);
  });

  it("maps error codes and reads the revealed message", () => {
    expect(moderationErrorText("not_found")).toMatch(/no longer exists/);
    expect(moderationErrorText("whatever")).toBeUndefined();
    expect(readFlaggedMessage({ text: "t", seq: 3 })).toEqual({ text: "t", seq: 3 });
    expect(readFlaggedMessage({ message: { text: "t" } })).toEqual({ text: "t" });
    expect(readFlaggedMessage(null)).toBeNull();
  });

  it("reads list bodies as {items} or an array", () => {
    expect(asList({ items: [1], next_cursor: "c" })).toEqual({ items: [1], next_cursor: "c" });
    expect(asList([1, 2])).toEqual({ items: [1, 2], next_cursor: null });
    expect(asList(null)).toEqual({ items: [], next_cursor: null });
  });
});

describe("deletion requests", () => {
  const req = (over: Partial<DeletionRequest> = {}): DeletionRequest => ({
    id: "d1",
    user_id: "u1",
    status: "requested",
    requested_at: "2026-10-20T10:00:00Z",
    open_sessions: 0,
    wallet_balance_paise: 0,
    ...over,
  });

  it("formats open sessions and balance", () => {
    expect(openSessionsText(0)).toBe("No");
    expect(openSessionsText(2)).toBe("Yes (2)");
    expect(openSessionsText(true)).toBe("Yes");
    expect(openSessionsText(false)).toBe("No");
    expect(openSessionsText(null)).toBe("–");
    expect(balanceText(15050)).toBe("₹150.50");
    expect(balanceText(0)).toBe("₹0");
    expect(balanceText(undefined)).toBe("–");
  });

  it("lists what blocks execution", () => {
    expect(deletionBlockers(req())).toEqual([]);
    expect(deletionBlockers(req({ open_sessions: 1, wallet_balance_paise: 2500 }))).toEqual([
      "Has an open session",
      "Wallet balance ₹25",
    ]);
    expect(deletionBlockers(req({ open_sessions: undefined, wallet_balance_paise: null }))).toEqual(
      [],
    );
  });

  it("offers Execute only for open requests", () => {
    expect(canExecute(req())).toBe(true);
    expect(canExecute(req({ status: "cancelled" }))).toBe(false);
    expect(canExecute(req({ status: "executed" }))).toBe(false);
    expect(deletionStatusLabel("cancelled")).toBe("Cancelled by the user");
    expect(deletionStatusLabel("some_state")).toBe("some state");
    expect(deletionFilter("all")).toBe("all");
    expect(deletionFilter("x")).toBe("requested");
  });

  it("says what to do for each refusal", () => {
    expect(deletionErrorText("balance_outstanding")).toMatch(/Settle the balance manually first/);
    expect(deletionErrorText("session_open")).toMatch(/Wait for it to end/);
    expect(deletionErrorText("not_requested")).toMatch(/no longer open/);
    expect(deletionErrorText("other")).toBeUndefined();
  });
});
