import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import enTools from "../messages/en/tools.json" with { type: "json" };
import hiTools from "../messages/hi/tools.json" with { type: "json" };
import { toolRoutes } from "../src/lib/routes/tools";
import { deviceCookieFlags, isHttps, sessionCookieFlags } from "../src/lib/tools/cookies";
import { HUB_ENTRIES, TOOLS } from "../src/lib/tools/registry";
import { toEngineBirth, validateBirth, validateDob, validateName } from "../src/lib/tools/validate";
import { band } from "../src/components/tools/MatchResult";

const exists = (locale: string, key: string) => {
  try {
    readFileSync(new URL(`../src/content/${locale}/${key}.json`, import.meta.url));
    return true;
  } catch {
    return false;
  }
};

describe("tool registry", () => {
  it("has the 9 /tools pages plus the kundli page = 10 launch tools", () => {
    expect(TOOLS).toHaveLength(9);
    expect(HUB_ENTRIES).toHaveLength(10);
    expect(new Set(TOOLS.map((t) => t.slug)).size).toBe(9);
  });

  it("every tool and page has content in both locales", () => {
    for (const key of [...TOOLS.map((t) => t.contentKey), "kundli", "kundli-matching", "tools"]) {
      expect(exists("en", key), `en/${key}`).toBe(true);
      expect(exists("hi", key), `hi/${key}`).toBe(true);
    }
  });

  it("every tool is in the sitemap routes, once", () => {
    const paths = toolRoutes().map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const t of TOOLS) expect(paths).toContain(`/tools/${t.slug}`);
    for (const p of ["/kundli", "/kundli-matching", "/tools"]) expect(paths).toContain(p);
  });

  it("every hub entry has a title and blurb in both locales", () => {
    for (const e of HUB_ENTRIES) {
      for (const m of [enTools, hiTools]) {
        const names = m.toolNames as Record<string, { title: string; blurb: string }>;
        expect(names[e.key]?.title, e.key).toBeTruthy();
        expect(names[e.key]?.blurb, e.key).toBeTruthy();
      }
    }
  });
});

describe("astro names come from data/astro, not retyped", () => {
  const data = (f: string) =>
    JSON.parse(readFileSync(new URL(`../../../data/astro/${f}`, import.meta.url), "utf8"));
  it.each([
    ["grahas.json", "grahas", "graha"],
    ["signs.json", "signs", "sign"],
    ["nakshatras.json", "nakshatras", "nakshatra"],
  ] as const)("%s", (file, listKey, ns) => {
    const rows = data(file)[listKey] as { id: string; en: string; hi: string }[];
    for (const row of rows) {
      expect((enTools.toolAstro as Record<string, Record<string, string>>)[ns]?.[row.id]).toBe(
        row.en,
      );
      expect((hiTools.toolAstro as Record<string, Record<string, string>>)[ns]?.[row.id]).toBe(
        row.hi,
      );
    }
  });
});

describe("validation", () => {
  const ok = {
    date: "2000-01-01",
    time: "12:00",
    place: { lat: 28.6, lon: 77.2, tz: "Asia/Kolkata" },
  };
  it("accepts a complete birth", () => expect(validateBirth(ok)).toEqual([]));
  it("accepts an unknown time", () => expect(validateBirth({ ...ok, time: null })).toEqual([]));
  it("rejects bad input", () => {
    expect(validateBirth({ ...ok, date: "2000-13-45" })).toContain("date_invalid");
    expect(validateBirth({ ...ok, date: "1700-01-01" })).toContain("date_out_of_range");
    expect(validateBirth({ ...ok, time: "25:00" })).toContain("time_invalid");
    expect(validateBirth({ ...ok, place: { lat: 95, lon: 0, tz: "UTC" } })).toContain(
      "place_required",
    );
    expect(validateBirth({ ...ok, place: { lat: 1, lon: 1, tz: "x; drop" } })).toContain(
      "place_required",
    );
  });
  it("names must be Latin letters", () => {
    expect(validateName("Asha Rao")).toEqual([]);
    expect(validateName("आशा")).toEqual(["latin_letters_required"]);
    expect(validateName(" ")).toEqual(["name_required"]);
  });
  it("dob", () => {
    expect(validateDob("1990-11-23")).toEqual([]);
    expect(validateDob("23/11/1990")).toEqual(["date_invalid"]);
  });
  it("engine payload drops UI-only fields (name, label, city id)", () => {
    const p = toEngineBirth({
      ...ok,
      name: "Asha",
      place: { ...ok.place, label: "Delhi", city_id: 1 },
    });
    expect(p).toEqual({ date: ok.date, time: ok.time, place: ok.place });
  });
});

describe("session cookies", () => {
  it("session token is httpOnly, SameSite=Lax, Secure on https", () => {
    const f = sessionCookieFlags(true, new Date(Date.now() + 3600_000).toISOString());
    expect(f).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/" });
    expect(f.maxAge).toBeGreaterThan(3500);
    expect(f.maxAge).toBeLessThanOrEqual(3600);
  });
  it("not Secure on plain http (local dev)", () => {
    expect(sessionCookieFlags(false).secure).toBe(false);
    expect(deviceCookieFlags(false).httpOnly).toBe(true);
  });
  it("detects https behind a proxy", () => {
    expect(isHttps("http://internal:3000/x", "https")).toBe(true);
    expect(isHttps("http://localhost:3000/x", null)).toBe(false);
  });
});

describe("matching band", () => {
  it("bands at 18 and 25", () => {
    expect(band(17.5)).toBe("low");
    expect(band(18)).toBe("mid");
    expect(band(25)).toBe("high");
  });
});
