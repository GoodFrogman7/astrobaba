import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { citySlugs } from "../src/lib/almanac/cities";
import {
  addDays,
  daysBetween,
  formatIstDate,
  istDays,
  parseIsoDate,
} from "../src/lib/almanac/dates";
import { AREAS, grahaName, houseOrdinal, SIGN_IDS } from "../src/lib/almanac/names";
import { areaSentences, moonSentences, scoreText } from "../src/lib/almanac/sentences";
import type { HoroscopeFacts } from "../src/lib/almanac/types";
import { almanacRoutes } from "../src/lib/routes/almanac";

// Real engine responses saved from GET /v1/horoscope/facts and /v1/panchang (never hand-typed).
const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/almanac/${name}`, import.meta.url), "utf8")) as T;
const FACTS: HoroscopeFacts[] = [
  fixture("facts-aries-daily-2026-10-21.json"),
  fixture("facts-leo-weekly-2026-10-21.json"),
  fixture("facts-pisces-monthly-2026-10-21.json"),
];

describe("IST dates", () => {
  it("today and tomorrow roll over at 00:00 IST (18:30 UTC), whatever the host zone", () => {
    expect(istDays(new Date("2026-10-21T18:29:59Z"))).toEqual({
      today: "2026-10-21",
      tomorrow: "2026-10-22",
    });
    expect(istDays(new Date("2026-10-21T18:30:00Z"))).toEqual({
      today: "2026-10-22",
      tomorrow: "2026-10-23",
    });
  });

  it("handles month and year ends", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(daysBetween("2026-10-21", "2027-10-21")).toBe(365);
  });

  it("accepts only real dates inside the engine's range", () => {
    expect(parseIsoDate("2026-10-21")).toBe("2026-10-21");
    for (const bad of [
      "2026-02-30",
      "2026-13-01",
      "1799-12-31",
      "2400-01-01",
      "21-10-2026",
      "2026-10-21x",
    ])
      expect(parseIsoDate(bad), bad).toBeNull();
  });

  it("formats the same calendar date in both locales", () => {
    expect(formatIstDate("2026-10-21", "en")).toBe("21 October 2026");
    expect(formatIstDate("2026-10-21", "hi")).toContain("2026");
    expect(formatIstDate("2026-10-21", "hi")).toMatch(/[ऀ-ॿ]/);
  });
});

describe("day-scoped loading", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("tomorrow's panchang is fetched for tomorrow's date, and today's is cached per IST day", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        const date = new URL(url).searchParams.get("date");
        return new Response(JSON.stringify({ date }), { status: 200 });
      }),
    );
    const { loadPanchang } = await import("../src/lib/almanac/data");
    const city = {
      slug: "x",
      geonameid: 1,
      name_en: "X",
      name_hi: null,
      lat: 28.6,
      lon: 77.2,
      tz: "Asia/Kolkata",
      population: 1,
    };
    const { today, tomorrow } = istDays(new Date());
    const a = await loadPanchang(city, today);
    const b = await loadPanchang(city, tomorrow);
    await loadPanchang(city, today);
    expect(a.date).toBe(today);
    expect(b.date).toBe(tomorrow);
    expect(a.date).not.toBe(b.date);
    expect(calls).toHaveLength(2); // the repeat request for today came from the cache
  });
});

describe("fact sentences", () => {
  it.each(FACTS.map((f) => [f.sign, f.period, f] as const))(
    "%s %s restates only engine facts",
    (_s, _p, facts) => {
      for (const locale of ["en", "hi"] as const) {
        for (const area of AREAS) {
          const lines = areaSentences(facts, area, locale);
          const a = facts.areas[area];
          expect(lines[0]).toContain(scoreText(a.score, a.label, locale));
          // One score line, then one line per effect (favourable, challenging) that occurs.
          expect(lines).toHaveLength(1 + new Set(a.reasons.map((r) => r.effect)).size);
          for (const r of a.reasons) {
            const placed =
              locale === "hi"
                ? `${grahaName(r.graha, "hi")} ${houseOrdinal(r.house_from_sign, "hi")} भाव में`
                : `${grahaName(r.graha, "en")} in the ${houseOrdinal(r.house_from_sign, "en")} house`;
            const line = lines.find((l) => l.includes(placed));
            expect(line, placed).toBeDefined();
            expect(
              line?.startsWith(
                r.effect === "favourable"
                  ? locale === "hi"
                    ? "अनुकूल"
                    : "Favourable"
                  : locale === "hi"
                    ? "चुनौती"
                    : "Challenging",
              ),
            ).toBe(true);
          }
          // No planet appears that is not among this area's reasons.
          const named = new Set(a.reasons.map((r) => r.graha));
          for (const g of [
            "sun",
            "moon",
            "mars",
            "mercury",
            "jupiter",
            "venus",
            "saturn",
            "rahu",
            "ketu",
          ]) {
            if (!named.has(g))
              for (const l of lines.slice(1)) expect(l).not.toContain(grahaName(g, locale));
          }
        }
        expect(moonSentences(facts, locale)).toHaveLength(facts.moon.ingresses.length + 1);
      }
    },
  );

  it("gives Moon ingress times in IST", () => {
    const daily = FACTS[0]!;
    const ing = daily.moon.ingresses[0]!;
    const istClock = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(ing.at));
    expect(moonSentences(daily, "en")[1]).toContain(`${istClock} IST`);
  });

  it("uses Hindi ordinals and English suffixes", () => {
    expect([1, 2, 3, 4, 11, 12].map((n) => houseOrdinal(n, "en"))).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
    ]);
    expect(houseOrdinal(11, "hi")).toBe("ग्यारहवें");
  });
});

describe("almanac routes", () => {
  const routes = almanacRoutes().map((r) => r.path);

  it("lists the hubs, every city's today and tomorrow page and all 36 horoscopes", () => {
    expect(routes).toContain("/panchang");
    expect(routes).toContain("/horoscope");
    for (const slug of citySlugs()) {
      expect(routes).toContain(`/panchang/${slug}`);
      expect(routes).toContain(`/panchang/${slug}/tomorrow`);
    }
    for (const period of ["daily", "weekly", "monthly"])
      for (const sign of SIGN_IDS) expect(routes).toContain(`/horoscope/${period}/${sign}`);
    expect(routes.filter((r) => r.startsWith("/horoscope/"))).toHaveLength(36);
  });

  it("keeps dated panchang URLs out of the sitemap and has no duplicates", () => {
    expect(routes.some((r) => /\d{4}-\d{2}-\d{2}/.test(r))).toBe(false);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it("covers the curated city list", () => {
    expect(citySlugs().length).toBeGreaterThanOrEqual(40);
    expect(citySlugs()).toContain("new-delhi");
  });
});
