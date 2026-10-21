import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/** scripts/claims-check.mjs (docs/api/trust.md §5), loaded as plain JS. */
interface Hit {
  rule: string;
  match: string;
  where: string;
}
interface ClaimsModule {
  DEFAULT_ROOT: string;
  scanText: (text: string) => { rule: string; match: string; index: number }[];
  check: (
    root?: string,
    opts?: { allow?: Record<string, string>[]; source?: boolean },
  ) => { files: string[]; hits: Hit[]; unused: unknown[] };
  targets: (root: string) => string[];
}
const SCRIPT = new URL("../../../scripts/claims-check.mjs", import.meta.url).href;
const load = async () => (await import(/* @vite-ignore */ SCRIPT)) as ClaimsModule;

const rules = (m: ClaimsModule, text: string) => m.scanText(text).map((h) => h.rule);

describe("claims check", () => {
  it("flags banned claims in English", async () => {
    const m = await load();
    expect(rules(m, "Guaranteed results in 7 days")).toContain("guarantee");
    expect(rules(m, "100% accurate predictions")).toContain("hundred_percent");
    expect(rules(m, "This puja cures diabetes")).toContain("cure");
    expect(rules(m, "A miracle remedy")).toContain("miracle");
    expect(rules(m, "Get instant results")).toContain("instant_results");
    expect(rules(m, "We remove all doshas")).toContain("dosha_removal");
    expect(rules(m, "Act before it's too late: black magic on your family")).toContain("fear");
    expect(rules(m, "Buy a certified gemstone today")).toContain("gemstone_sale");
  });

  it("flags banned claims in Hindi, with Devanagari word boundaries", async () => {
    const m = await load();
    expect(rules(m, "सफलता की गारंटी")).toContain("guarantee");
    expect(rules(m, "हर रोग का इलाज")).toContain("cure");
    expect(rules(m, "चमत्कारी उपाय")).toContain("miracle");
    expect(rules(m, "तुरंत परिणाम पाएँ")).toContain("instant_results");
    expect(rules(m, "सभी दोष दूर करें")).toContain("dosha_removal");
    expect(rules(m, "काला जादू हटाएँ")).toContain("fear");
    expect(rules(m, "आज ही रत्न ख़रीदें")).toContain("gemstone_sale");
    expect(rules(m, "शर्तिया समाधान")).toContain("assured_results");
    // Not inside other words: "ऑर्डर" (order) contains "डर" (fear), "secure" contains "cure".
    expect(m.scanText("आपका ऑर्डर बन रहा है। Your payment is secure and accurate.")).toEqual([]);
  });

  it("fails on a fixture repository and points at file:key and file:line", async () => {
    const m = await load();
    const root = mkdtempSync(join(tmpdir(), "claims-"));
    const put = (p: string, body: string) => {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), body);
    };
    put(
      "apps/web/messages/en/x.json",
      JSON.stringify({ promo: { title: "Guaranteed love back", ok: "No outcome is guaranteed." } }),
    );
    put("apps/web/src/content/hi/page.md", "पहली पंक्ति\nचमत्कार देखें\n");
    put("data/marketplace/remedies.json", JSON.stringify({ $comment: "no cures", list: ["Cure"] }));
    put("data/marketplace/products.json", "{}");
    put("apps/admin/src/a.tsx", 'const t = "Cure claim"; // a cure comment\n');
    const allow = [{ phrase: "no outcome is guaranteed", reason: "negation" }];
    const r = m.check(root, { allow });
    expect(r.hits.map((h) => `${h.where} ${h.rule}`)).toEqual([
      "apps/web/messages/en/x.json:promo.title guarantee",
      "apps/web/src/content/hi/page.md:2 miracle",
      "data/marketplace/remedies.json:list[0] cure",
    ]);
    expect(r.unused).toEqual([]);
    // Inline copy in other apps only with --source; comments are never copy.
    const src = m.check(root, { allow, source: true });
    expect(src.hits.map((h) => h.where)).toContain("apps/admin/src/a.tsx:1");
    expect(src.hits.filter((h) => h.where === "apps/admin/src/a.tsx:1")).toHaveLength(1);
    // A whole file can be allowed (it lists banned claims on purpose); patterns use `*`.
    const whole = m.check(root, {
      allow: [...allow, { file: "apps/admin/src/*.tsx", reason: "rules text" }],
      source: true,
    });
    expect(whole.hits.map((h) => h.where)).not.toContain("apps/admin/src/a.tsx:1");
    // Without --source that file is not read, so its entry is not reported as stale.
    expect(
      m.check(root, { allow: [...allow, { file: "apps/admin/src/a.tsx", reason: "r" }] }).unused,
    ).toEqual([]);
    // An allow entry that no longer matches anything is reported.
    expect(m.check(root, { allow: [...allow, { phrase: "x", reason: "y" }] }).unused).toHaveLength(
      1,
    );
  });

  it("passes on this repository's user-facing copy", async () => {
    const m = await load();
    const r = m.check(m.DEFAULT_ROOT);
    expect(r.files).toContain("apps/web/messages/en/trust.json");
    expect(r.files).toContain("data/marketplace/remedies.json");
    expect(r.files).toContain("data/marketplace/products.json");
    expect(r.files.some((f) => f.startsWith("apps/web/src/content/hi/legal/"))).toBe(true);
    expect(r.hits).toEqual([]);
  });
});
