import { describe, expect, it } from "vitest";
import {
  MAX_PRICE_PAISE,
  MIN_PRICE_PAISE,
  validateApplication,
} from "../src/lib/marketplace/application";
import {
  EMPTY_FILTERS,
  hasFilters,
  parseCursor,
  parseFilters,
  toApiQuery,
  toPageQuery,
} from "../src/lib/marketplace/filters";
import { initials, rupeesPerMin } from "../src/lib/marketplace/format";
import { personLd } from "../src/lib/marketplace/jsonld";
import { TAXONOMY } from "../src/lib/marketplace/taxonomy";
import type { AstrologerProfile } from "../src/lib/marketplace/types";
import {
  checkFile,
  checkUploadHeaders,
  limitStream,
  MAX_BODY_BYTES,
  MAX_FILE_BYTES,
} from "../src/lib/marketplace/upload";
import profile from "./fixtures/marketplace/profile.json" with { type: "json" };

describe("directory filters (URL query ↔ API params)", () => {
  it("maps every filter to the API contract, rupees to paise", () => {
    const f = parseFilters({
      skill: ["vedic", "tarot"],
      language: "hi",
      gender: "female",
      tier: "rising",
      min_price: "10",
      max_price: "50",
      online: "1",
      sort: "price_asc",
    });
    const q = toApiQuery(f, "abc_123", 20);
    expect(q.getAll("skill")).toEqual(["vedic", "tarot"]);
    expect(q.getAll("language")).toEqual(["hi"]);
    expect(q.get("gender")).toBe("female");
    expect(q.get("tier")).toBe("rising");
    expect(q.get("min_price")).toBe("1000");
    expect(q.get("max_price")).toBe("5000");
    expect(q.get("online")).toBe("true");
    expect(q.get("sort")).toBe("price_asc");
    expect(q.get("cursor")).toBe("abc_123");
    expect(q.get("limit")).toBe("20");
  });

  it("drops invalid values instead of passing them on", () => {
    const f = parseFilters({
      skill: ["vedic", "black-magic", "vedic"],
      language: ["xx", "<script>"],
      gender: "robot",
      tier: "vip",
      min_price: "-5",
      max_price: "1e9",
      online: "yes please",
      sort: "random",
    });
    expect(f).toEqual({ ...EMPTY_FILTERS, skills: ["vedic"] });
    const q = toApiQuery(EMPTY_FILTERS, null);
    expect([...q.keys()].sort()).toEqual(["limit", "sort"]);
  });

  it("swaps a reversed price range and caps repeated values", () => {
    const f = parseFilters({
      min_price: "80",
      max_price: "20",
      skill: TAXONOMY.skills.map((s) => s.id),
    });
    expect([f.minRupees, f.maxRupees]).toEqual([20, 80]);
    expect(f.skills).toHaveLength(5);
  });

  it("knows when the view is filtered (noindex) and keeps page links minimal", () => {
    expect(hasFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasFilters(parseFilters({ sort: "rating" }))).toBe(true);
    expect(hasFilters(parseFilters({ online: "1" }))).toBe(true);
    expect(toPageQuery(EMPTY_FILTERS)).toBe("");
    expect(toPageQuery(parseFilters({ skill: "kp", min_price: "15" }), { cursor: "c1" })).toBe(
      "?skill=kp&min_price=15&cursor=c1",
    );
  });

  it("accepts only opaque-looking cursors", () => {
    expect(parseCursor({ cursor: "b2Zmc2V0OjIw" })).toBe("b2Zmc2V0OjIw");
    expect(parseCursor({ cursor: "../../etc" })).toBeNull();
    expect(parseCursor({ cursor: "a b" })).toBeNull();
    expect(parseCursor({ reviews: "cj0y" }, "reviews")).toBe("cj0y");
  });
});

describe("Person JSON-LD", () => {
  it("has name, url, skills and languages, and no aggregateRating", () => {
    const ld = personLd(profile as unknown as AstrologerProfile, "en");
    expect(ld["@type"]).toBe("Person");
    expect(ld.name).toBe("Meera Joshi");
    expect(String(ld.url)).toMatch(/\/astrologers\/meera-joshi$/);
    expect(ld.knowsAbout).toEqual(["Tarot", "Numerology"]);
    expect(ld.knowsLanguage).toEqual([
      { "@type": "Language", name: "Marathi", alternateName: "mr" },
      { "@type": "Language", name: "Hindi", alternateName: "hi" },
    ]);
    expect(JSON.stringify(ld)).not.toMatch(/aggregateRating|review/i);
    const hi = personLd(profile as unknown as AstrologerProfile, "hi");
    expect(String(hi.url)).toMatch(/\/hi\/astrologers\/meera-joshi$/);
    expect(hi.knowsAbout).toEqual(["टैरो", "अंक ज्योतिष"]);
  });
});

describe("KYC upload limits (web pass-through)", () => {
  it("requires multipart and rejects declared oversize bodies", () => {
    expect(checkUploadHeaders("application/json", "10")).toEqual({
      ok: false,
      status: 415,
      code: "multipart_required",
    });
    expect(
      checkUploadHeaders("multipart/form-data; boundary=x", String(MAX_BODY_BYTES + 1)),
    ).toEqual({
      ok: false,
      status: 413,
      code: "file_too_large",
    });
    expect(checkUploadHeaders("multipart/form-data; boundary=x", String(MAX_BODY_BYTES))).toEqual({
      ok: true,
    });
    expect(checkUploadHeaders("multipart/form-data; boundary=x", null)).toEqual({ ok: true });
  });

  it("stops a stream that exceeds the limit even without a content-length", async () => {
    const chunk = new Uint8Array(1024);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 4; i++) c.enqueue(chunk);
        c.close();
      },
    });
    const reader = limitStream(body, 3000).getReader();
    let total = 0;
    await expect(
      (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
        }
      })(),
    ).rejects.toThrow("file_too_large");
    expect(total).toBeLessThanOrEqual(3000);
  });

  it("pre-checks file size and type on the client", () => {
    expect(checkFile({ size: 100, type: "application/pdf" })).toBeNull();
    expect(checkFile({ size: MAX_FILE_BYTES + 1, type: "image/png" })).toBe("file_too_large");
    expect(checkFile({ size: 100, type: "image/gif" })).toBe("unsupported_type");
  });
});

describe("application validation", () => {
  const ok = {
    display_name: "Meera Joshi",
    bio: "I read tarot and numerology with a focus on practical next steps for my clients.",
    skills: ["tarot"],
    languages: ["mr", "hi"],
    gender: "female",
    experience_years: 3,
    requested_price_per_min_paise: MIN_PRICE_PAISE,
    accepts_terms: true,
  };
  it("accepts a complete application", () => {
    expect(validateApplication(ok)).toEqual([]);
  });
  it("names every invalid field", () => {
    expect(
      validateApplication({
        ...ok,
        display_name: "M",
        bio: "short",
        skills: ["astral-travel"],
        languages: [],
        gender: "x",
        experience_years: 3.5,
        requested_price_per_min_paise: MAX_PRICE_PAISE + 1,
        accepts_terms: false,
      }),
    ).toEqual([
      "display_name",
      "bio",
      "skills",
      "languages",
      "gender",
      "experience_years",
      "requested_price_per_min_paise",
      "accepts_terms",
    ]);
    expect(validateApplication(null)).toEqual(["invalid_body"]);
  });
});

describe("formatting", () => {
  it("formats paise as rupees per minute and builds initials", () => {
    expect(rupeesPerMin(4500, "en")).toBe("₹45");
    expect(rupeesPerMin(1250, "en")).toBe("₹12.50");
    expect(initials("Meera  Joshi")).toBe("MJ");
    expect(initials("मीरा")).toBe("म");
    expect(initials("")).toBe("?");
  });
});
