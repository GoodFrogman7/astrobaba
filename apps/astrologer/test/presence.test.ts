import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHeartbeat, HEARTBEAT_MS, newRequestIds } from "../src/lib/presence";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("presence heartbeat", () => {
  it("goes online at once and beats every 60 s until offline", async () => {
    const send = vi.fn(async () => ({ ok: true, status: 200 }));
    const hb = createHeartbeat({ send });
    await hb.goOnline();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith("online");
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(send).toHaveBeenCalledTimes(4);
    await hb.goOffline();
    expect(send).toHaveBeenLastCalledWith("offline");
    expect(hb.running).toBe(false);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(send).toHaveBeenCalledTimes(5);
  });

  it("beats well inside the 120 s presence TTL", () => {
    expect(HEARTBEAT_MS * 2).toBeLessThanOrEqual(120_000);
  });

  it("does not keep beating when going online is refused", async () => {
    const send = vi.fn(async () => ({ ok: false, status: 409 }));
    const hb = createHeartbeat({ send });
    expect((await hb.goOnline()).ok).toBe(false);
    expect(hb.running).toBe(false);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps beating through transient failures and reports them", async () => {
    const results = [
      { ok: true, status: 200 },
      { ok: false, status: 503 },
      { ok: true, status: 200 },
    ];
    const send = vi.fn(async () => results.shift() ?? { ok: true, status: 200 });
    const onBeat = vi.fn();
    const hb = createHeartbeat({ send, onBeat });
    await hb.goOnline();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(onBeat.mock.calls).toEqual([
      [true, 200, undefined],
      [false, 503, undefined],
      [true, 200, undefined],
    ]);
    hb.dispose();
  });

  it("stops beating when the astrologer terms are needed (403 consent_required)", async () => {
    const results = [
      { ok: true, status: 200 },
      { ok: false, status: 403, code: "consent_required" },
    ];
    const send = vi.fn(async () => results.shift() ?? { ok: true, status: 200 });
    const onBeat = vi.fn();
    const hb = createHeartbeat({ send, onBeat });
    await hb.goOnline();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(onBeat).toHaveBeenLastCalledWith(false, 403, "consent_required");
    expect(hb.running).toBe(false);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("dispose stops beating without sending offline (the TTL expires it)", async () => {
    const send = vi.fn(async () => ({ ok: true, status: 200 }));
    const hb = createHeartbeat({ send });
    await hb.goOnline();
    hb.dispose();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("new request detection", () => {
  it("reports requested sessions not seen before", () => {
    const items = [
      { id: "a", status: "requested" },
      { id: "b", status: "queued" },
      { id: "c", status: "requested" },
    ];
    expect(newRequestIds(new Set(["a"]), items)).toEqual(["c"]);
    expect(newRequestIds(new Set(["a", "c"]), items)).toEqual([]);
  });
});
