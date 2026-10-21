import type { ContentItem, ReadinessCheck } from "@astro/shared";
import { describe, expect, it } from "vitest";
import {
  almanacLabel,
  almanacTitle,
  barWidth,
  classifyRate,
  coverageStatus,
  defaultContentRange,
  defaultFunnelRange,
  formatRate,
  formatTarget,
  funnelApiPath,
  groupByWeek,
  isContentUrl,
  isCoreHour,
  mondayOf,
  parseContentForm,
  parseContentQuery,
  parseFunnelQuery,
  parseInviteForm,
  readinessLabel,
  readinessTotals,
  scheduleGrid,
  sortChecks,
  supplyStatus,
  type ContentFields,
} from "../src/lib/growth-admin";

describe("IST default ranges", () => {
  it("funnel: the last 28 full IST days, ending yesterday", () => {
    // 10:00 UTC = 15:30 IST on 21 Oct.
    expect(defaultFunnelRange(new Date("2026-10-21T10:00:00Z"))).toEqual({
      from: "2026-09-23",
      to: "2026-10-20",
    });
  });

  it("funnel: uses the IST date, not UTC, near midnight", () => {
    // 20:00 UTC on 21 Oct is already 01:30 IST on 22 Oct.
    expect(defaultFunnelRange(new Date("2026-10-21T20:00:00Z"))).toEqual({
      from: "2026-09-24",
      to: "2026-10-21",
    });
  });

  it("content: this IST week from Monday plus the next 5 weeks", () => {
    // Wednesday 21 Oct 2026 → Monday 19 Oct to Sunday 29 Nov.
    expect(defaultContentRange(new Date("2026-10-21T10:00:00Z"))).toEqual({
      from: "2026-10-19",
      to: "2026-11-29",
    });
    // Sunday 25 Oct 19:00 UTC is Monday 26 Oct 00:30 IST: a new week has started.
    expect(defaultContentRange(new Date("2026-10-25T19:00:00Z")).from).toBe("2026-10-26");
  });

  it("mondayOf handles Sunday and Monday", () => {
    expect(mondayOf("2026-10-25")).toBe("2026-10-19");
    expect(mondayOf("2026-10-26")).toBe("2026-10-26");
  });
});

describe("funnel query", () => {
  const now = new Date("2026-10-21T10:00:00Z");

  it("defaults everything", () => {
    const { query, problems } = parseFunnelQuery({}, now);
    expect(query).toEqual({
      from: "2026-09-23",
      to: "2026-10-20",
      window_days: 30,
      locale: "all",
      source: "all",
    });
    expect(problems).toEqual([]);
    expect(funnelApiPath(query)).toBe(
      "/v1/admin/growth/funnel?from=2026-09-23&to=2026-10-20&window_days=30",
    );
  });

  it("passes valid filters to the API", () => {
    const { query } = parseFunnelQuery(
      { from: "2026-08-01", to: "2026-08-31", window_days: "7", locale: "hi", source: "search" },
      now,
    );
    expect(funnelApiPath(query)).toBe(
      "/v1/admin/growth/funnel?from=2026-08-01&to=2026-08-31&window_days=7&locale=hi&source=search",
    );
  });

  it("rejects bad dates, reversed and too-long ranges, and bad windows", () => {
    expect(parseFunnelQuery({ from: "2026-02-30" }, now).problems).toHaveLength(1);
    expect(parseFunnelQuery({ from: "2026-10-10", to: "2026-10-01" }, now).problems).toHaveLength(
      1,
    );
    // 1 Jan to 4 Apr is 93 days apart; 1 Jan to 3 Apr (92) is the longest allowed.
    const long = parseFunnelQuery({ from: "2026-01-01", to: "2026-04-04" }, now);
    expect(long.problems[0]).toMatch(/92 days/);
    expect(long.query.from).toBe("2026-09-23");
    expect(parseFunnelQuery({ from: "2026-01-01", to: "2026-04-03" }, now).problems).toEqual([]);
    for (const w of ["0", "91", "2.5", "x"]) {
      const r = parseFunnelQuery({ window_days: w }, now);
      expect(r.query.window_days).toBe(30);
      expect(r.problems).toHaveLength(1);
    }
    expect(parseFunnelQuery({ locale: "fr", source: "tv" }, now).query).toMatchObject({
      locale: "all",
      source: "all",
    });
  });
});

describe("target classification", () => {
  const range = { low: 0.08, high: 0.12 };

  it("classifies below, within (inclusive bounds) and above", () => {
    expect(classifyRate(0.05, range)).toBe("below");
    expect(classifyRate(0.08, range)).toBe("within");
    expect(classifyRate(0.12, range)).toBe("within");
    expect(classifyRate(0.2, range)).toBe("above");
  });

  it("an open-ended target is met at or above low", () => {
    expect(classifyRate(0.39, { low: 0.4, high: null })).toBe("below");
    expect(classifyRate(0.9, { low: 0.4, high: null })).toBe("within");
  });

  it("is null without a rate or a target", () => {
    expect(classifyRate(null, range)).toBeNull();
    expect(classifyRate(0.1, null)).toBeNull();
  });

  it("a zero target is always met", () => {
    expect(classifyRate(0, { low: 0, high: null })).toBe("within");
    expect(classifyRate(0, { low: 0, high: 0 })).toBe("within");
    expect(classifyRate(0.01, { low: 0, high: 0 })).toBe("above");
  });

  it("formats rates, targets and bars", () => {
    expect(formatRate(null)).toBe("—");
    expect(formatRate(0.1234)).toBe("12.3%");
    expect(formatRate(1)).toBe("100%");
    expect(formatTarget(range)).toBe("8%–12%");
    expect(formatTarget({ low: 0.4, high: null })).toBe("≥ 40%");
    expect(formatTarget(null)).toBe("—");
    expect(barWidth(50, 200)).toBe(25);
    expect(barWidth(5, 0)).toBe(0);
    expect(barWidth(300, 200)).toBe(100);
  });
});

describe("supply helpers", () => {
  it("describes live against the target range", () => {
    expect(supplyStatus(12, { min: 30, max: 50 })).toBe("Below minimum (18 short)");
    expect(supplyStatus(30, { min: 30, max: 50 })).toBe("Within target range");
    expect(supplyStatus(51, { min: 30, max: 50 })).toBe("Above target range");
    expect(supplyStatus(0, { min: 0, max: 0 })).toBe("Within target range");
  });

  it("coverage with a zero minimum is not shown as met or short", () => {
    expect(coverageStatus({ id: "hi", live: 0, target_min: 0 })).toBe("No minimum set");
    expect(coverageStatus({ id: "hi", live: 4, target_min: 15 })).toBe("Short by 11");
    expect(coverageStatus({ id: "hi", live: 15, target_min: 15 })).toBe("Meets minimum");
  });

  it("core hours follow targets.json (9:00 up to 23:00 IST, every day)", () => {
    expect(isCoreHour(0, 9)).toBe(true);
    expect(isCoreHour(6, 22)).toBe(true);
    expect(isCoreHour(0, 8)).toBe(false);
    expect(isCoreHour(0, 23)).toBe(false);
  });

  it("accepts only a 7x24 schedule", () => {
    const ok = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    expect(scheduleGrid(ok)).toBe(ok);
    expect(scheduleGrid(ok.slice(1))).toBeNull();
    expect(scheduleGrid([...ok.slice(1), [1, 2]])).toBeNull();
    expect(scheduleGrid(undefined)).toBeNull();
  });
});

describe("invite form", () => {
  it("defaults to 14 days and omits an empty note", () => {
    expect(parseInviteForm({ note: "  ", expires_days: "" })).toEqual({
      ok: true,
      value: { expires_days: 14 },
    });
    expect(parseInviteForm({ note: " Delhi batch ", expires_days: "60" })).toEqual({
      ok: true,
      value: { note: "Delhi batch", expires_days: 60 },
    });
  });

  it("bounds the note and the expiry", () => {
    expect(parseInviteForm({ note: "x".repeat(201), expires_days: "14" }).ok).toBe(false);
    expect(parseInviteForm({ note: "x".repeat(200), expires_days: "14" }).ok).toBe(true);
    for (const d of ["0", "61", "1.5", "abc"]) {
      expect(parseInviteForm({ note: "", expires_days: d }).ok).toBe(false);
    }
  });
});

describe("content form validation", () => {
  const base: ContentFields = {
    title: "Saturn return explainer",
    kind: "article",
    locale: "both",
    status: "idea",
    due_date: "2026-11-05",
    url: "",
    notes: "",
  };

  it("accepts a valid item and normalises empty fields to null", () => {
    expect(parseContentForm(base)).toEqual({
      ok: true,
      value: { ...base, url: null, notes: null },
    });
  });

  it("requires a URL when published", () => {
    const r = parseContentForm({ ...base, status: "published" });
    expect(r).toEqual({ ok: false, error: "A published item needs its URL." });
    expect(parseContentForm({ ...base, status: "published", url: "/learn/saturn" }).ok).toBe(true);
  });

  it("accepts only a site path or an https URL", () => {
    for (const ok of ["/learn/saturn", "/", "https://example.com/post"]) {
      expect(isContentUrl(ok)).toBe(true);
    }
    for (const bad of [
      "//evil.example",
      "http://example.com",
      "learn/saturn",
      "javascript:alert(1)",
      "/a b",
      "https://",
    ]) {
      expect(isContentUrl(bad)).toBe(false);
    }
    expect(parseContentForm({ ...base, url: "http://example.com" }).ok).toBe(false);
  });

  it("checks title, notes, enums and the due date", () => {
    expect(parseContentForm({ ...base, title: "  " }).ok).toBe(false);
    expect(parseContentForm({ ...base, title: "x".repeat(161) }).ok).toBe(false);
    expect(parseContentForm({ ...base, title: "x".repeat(160) }).ok).toBe(true);
    expect(parseContentForm({ ...base, notes: "x".repeat(1001) }).ok).toBe(false);
    expect(parseContentForm({ ...base, kind: "podcast" }).ok).toBe(false);
    expect(parseContentForm({ ...base, locale: "ta" }).ok).toBe(false);
    expect(parseContentForm({ ...base, status: "live" }).ok).toBe(false);
    expect(parseContentForm({ ...base, due_date: "2026-02-30" }).ok).toBe(false);
    expect(parseContentForm({ ...base, due_date: "" })).toMatchObject({
      ok: true,
      value: { due_date: null },
    });
  });

  it("reads calendar filters and the prefill from the query", () => {
    const now = new Date("2026-10-21T10:00:00Z");
    expect(parseContentQuery({}, now)).toMatchObject({
      from: "2026-10-19",
      to: "2026-11-29",
      status: null,
      kind: null,
      problem: null,
      prefill: { due_date: "", title: "" },
    });
    const q = parseContentQuery(
      {
        from: "2026-12-01",
        to: "2026-11-01",
        status: "review",
        kind: "nope",
        new_date: "2026-11-05",
        new_title: "Purnima",
      },
      now,
    );
    expect(q).toMatchObject({
      from: "2026-10-19",
      status: "review",
      kind: null,
      prefill: { due_date: "2026-11-05", title: "Purnima" },
    });
    expect(q.problem).not.toBeNull();
  });

  it("groups items by due week, undated last", () => {
    const item = (id: string, due: string | null) =>
      ({ id, title: id, due_date: due }) as unknown as ContentItem;
    const groups = groupByWeek([
      item("a", "2026-10-28"),
      item("b", null),
      item("c", "2026-10-19"),
      item("d", "2026-10-25"),
    ]);
    expect(groups.map((g) => [g.week, g.items.map((i) => i.id)])).toEqual([
      ["2026-10-19", ["c", "d"]],
      ["2026-10-26", ["a"]],
      [null, ["b"]],
    ]);
  });
});

describe("almanac labels", () => {
  it("names the tithi basis and the sidereal sign", () => {
    expect(almanacLabel({ date: "2026-11-05", kind: "purnima" })).toBe(
      "Purnima (tithi at sunrise, New Delhi)",
    );
    expect(almanacLabel({ date: "2026-11-05", kind: "amavasya" })).toBe(
      "Amavasya (tithi at sunrise, New Delhi)",
    );
    expect(almanacLabel({ date: "2026-11-05", kind: "ekadashi" })).toBe(
      "Ekadashi (tithi at sunrise, New Delhi)",
    );
    expect(almanacLabel({ date: "2026-11-16", kind: "sun_sign_change", sign: "scorpio" })).toBe(
      "Sun enters Scorpio (sidereal)",
    );
    expect(almanacLabel({ date: "2026-11-16", kind: "sun_sign_change" })).toBe(
      "Sun enters a new sign (sidereal)",
    );
  });

  it("builds a prefill title", () => {
    expect(almanacTitle({ date: "2026-11-05", kind: "purnima" })).toBe("Purnima: 2026-11-05");
    expect(almanacTitle({ date: "2026-11-16", kind: "sun_sign_change", sign: "scorpio" })).toMatch(
      /^Sun enters Scorpio: /,
    );
  });
});

describe("launch readiness", () => {
  const c = (id: string, status: ReadinessCheck["status"]) =>
    ({ id, status, detail: "" }) as ReadinessCheck;

  it("orders fail, warn, pass and keeps the contract order inside each", () => {
    const sorted = sortChecks([
      c("ai_ready", "pass"),
      c("sms_live", "warn"),
      c("payments_live", "fail"),
      c("legal_approved", "pass"),
      c("legal_approved_x" as never, "fail"),
      c("jobs_healthy", "warn"),
    ]);
    expect(sorted.map((x) => x.id)).toEqual([
      "payments_live",
      "legal_approved_x",
      "sms_live",
      "jobs_healthy",
      "legal_approved",
      "ai_ready",
    ]);
    expect(readinessTotals(sorted)).toEqual({ fail: 2, warn: 2, pass: 2 });
  });

  it("has a human label for every contract id and a fallback for unknown ones", () => {
    expect(readinessLabel("payments_live")).toBe("Live payments (Razorpay)");
    expect(readinessLabel("new_check")).toBe("new check");
  });
});
