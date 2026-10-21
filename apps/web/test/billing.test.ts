import { describe, expect, it } from "vitest";
import billingFile from "../../../data/marketplace/billing.json" with { type: "json" };
import {
  inBounds,
  paiseToInput,
  parseRupees,
  prefillFromQuery,
  shortfallPaise,
} from "../src/lib/billing/amount";
import { BILLING, minStartPaise } from "../src/lib/billing/config";
import { IDEMPOTENCY_KEY, IntentKeys, newIdempotencyKey } from "../src/lib/billing/idempotency";
import { pollDelay, pollOrder } from "../src/lib/billing/poll";
import { outcomeFor } from "../src/lib/billing/start";
import type { RechargeOrder } from "../src/lib/billing/types";
import { clock, formatPaise } from "../src/lib/marketplace/format";

const bounds = { min_paise: 10000, max_paise: 5000000 };

describe("money formatting (one helper for every price)", () => {
  it("shows whole rupees without paise and paise when there are any", () => {
    expect(formatPaise(50000, "en")).toBe("₹500");
    expect(formatPaise(1250, "en")).toBe("₹12.50");
    expect(formatPaise(5000000, "en")).toBe("₹50,000");
    expect(formatPaise(10000050, "en")).toBe("₹1,00,000.50");
    expect(formatPaise(0, "en")).toBe("₹0");
  });

  it("signs transactions from the user's view", () => {
    expect(formatPaise(50000, "en", { signed: true })).toBe("+₹500");
    expect(formatPaise(-1250, "en", { signed: true })).toBe("−₹12.50");
    expect(formatPaise(0, "en", { signed: true })).toBe("₹0");
  });

  it("formats in Hindi with the same digits and grouping", () => {
    expect(formatPaise(150050, "hi")).toBe("₹1,500.50");
  });

  it("clock shows m:ss, then h:mm:ss", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(61)).toBe("1:01");
    expect(clock(3725)).toBe("1:02:05");
    expect(clock(-5)).toBe("0:00");
  });
});

describe("recharge amounts", () => {
  it("parses rupees as typed into integer paise", () => {
    expect(parseRupees("250")).toBe(25000);
    expect(parseRupees("250.5")).toBe(25050);
    expect(parseRupees("₹1,000.25")).toBe(100025);
    expect(parseRupees("1e3")).toBeNull();
    expect(parseRupees("-5")).toBeNull();
    expect(parseRupees("1.234")).toBeNull();
    expect(parseRupees("")).toBeNull();
    expect(paiseToInput(25000)).toBe("250");
    expect(paiseToInput(25050)).toBe("250.50");
  });

  it("checks bounds from the API's recharge options", () => {
    expect(inBounds(10000, bounds)).toBe(true);
    expect(inBounds(9999, bounds)).toBe(false);
    expect(inBounds(5000001, bounds)).toBe(false);
  });

  it("suggests the missing amount, in whole rupees, at least the minimum recharge", () => {
    expect(shortfallPaise(2500, 1000, bounds)).toBe(10000);
    expect(shortfallPaise(150050, 1000, bounds)).toBe(149100);
    expect(shortfallPaise(9e9, 0, bounds)).toBe(5000000);
  });

  it("a ?amount= prefill is used only when it is a valid amount", () => {
    expect(prefillFromQuery("25000", bounds)).toBe(25000);
    expect(prefillFromQuery("50", bounds)).toBeNull();
    expect(prefillFromQuery("abc", bounds)).toBeNull();
    expect(prefillFromQuery(null, bounds)).toBeNull();
  });

  it("explains rules from data/marketplace/billing.json, not retyped numbers", () => {
    expect(BILLING.minStartMinutes).toBe(billingFile.sessions.min_start_minutes);
    expect(BILLING.recharge.minPaise).toBe(billingFile.recharge.min_paise);
    expect(minStartPaise(1250)).toBe(1250 * billingFile.sessions.min_start_minutes);
  });
});

describe("idempotency keys per intent", () => {
  it("reuses the key for the same intent until done, and is a valid header", () => {
    let n = 0;
    const keys = new IntentKeys(() => `key-0000-${++n}`);
    const a = keys.for("recharge:50000");
    expect(keys.for("recharge:50000")).toBe(a);
    expect(keys.for("recharge:100000")).not.toBe(a);
    const b = keys.for("recharge:100000");
    keys.done();
    expect(keys.for("recharge:100000")).not.toBe(b);
    expect(newIdempotencyKey()).toMatch(IDEMPOTENCY_KEY);
  });
});

describe("waiting for the webhook", () => {
  const order = (status: RechargeOrder["status"]): RechargeOrder => ({
    id: "o1",
    status,
    amount_paise: 50000,
    bonus_paise: 0,
    currency: "INR",
    provider: "fake",
    provider_order_id: "order_x",
    key_id: "",
    created_at: "2026-10-21T10:00:00Z",
    paid_at: null,
  });

  it("polls until paid or failed, with growing delays", async () => {
    const answers = [order("created"), null, order("created"), order("paid")];
    const slept: number[] = [];
    const r = await pollOrder(async () => answers.shift() ?? null, {
      sleep: async (ms) => void slept.push(ms),
    });
    expect(r).toEqual({ order: order("paid"), settled: true });
    expect(slept).toEqual([1000, 1500, 2000]);
    expect(pollDelay(100)).toBe(5000);
  });

  it("gives up after the time limit without inventing a result", async () => {
    const r = await pollOrder(async () => order("created"), { sleep: async () => {}, maxMs: 4000 });
    expect(r.settled).toBe(false);
    expect(r.order?.status).toBe("created");
  });
});

describe("starting a chat: what the user is told", () => {
  const ctx = { pricePerMinPaise: 1250, balancePaise: 1000 };
  it("insufficient funds says how many minutes the balance covers and what to add", () => {
    expect(
      outcomeFor(
        402,
        { code: "insufficient_funds", minutes_affordable: 0, required_paise: 2500 },
        ctx,
      ),
    ).toEqual({ kind: "insufficient", minutes: 0, required: 2500, suggest: 10000 });
    // Without the extras, falls back to the same rule the API applies.
    expect(outcomeFor(402, { code: "insufficient_funds" }, ctx)).toMatchObject({
      required: minStartPaise(1250),
      minutes: 0,
    });
  });

  it("maps the other create checks", () => {
    expect(outcomeFor(401, { code: "not_signed_in" }, ctx)).toEqual({ kind: "signin" });
    expect(outcomeFor(409, { code: "session_open", session_id: "s1" }, ctx)).toEqual({
      kind: "open",
      sessionId: "s1",
    });
    expect(outcomeFor(409, { code: "own_profile" }, ctx)).toEqual({
      kind: "message",
      key: "ownProfile",
    });
    expect(outcomeFor(409, { code: "chat_unavailable" }, ctx).kind).toBe("message");
    expect(outcomeFor(403, { code: "free_session_unavailable", reason: "device" }, ctx)).toEqual({
      kind: "message",
      key: "freeUnavailable",
    });
    expect(outcomeFor(0, { code: "network_error" }, ctx)).toEqual({
      kind: "message",
      key: "generic",
    });
  });
});
