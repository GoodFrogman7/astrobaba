#!/usr/bin/env node
// Copy check for banned marketing claims (docs/api/trust.md §5, PLAN.md Phase 7 policy).
//
// Scans user-facing copy in English and Hindi: the apps' message files and content files,
// data/marketplace/remedies.json and products.json. Fails (exit 1) on guarantees, cures,
// "100%", miracles, instant results, dosha removal, fear wording and gemstone selling, printing
// file:key (JSON) or file:line (text) for each hit. A legitimate use (e.g. "no outcome is
// guaranteed") needs an entry in scripts/claims-check/allow.json with a reason.
//
// Usage: node scripts/claims-check.mjs [--root <dir>] [--source]
//   --source  also scan string literals in apps/admin and apps/astrologer .ts/.tsx files
//             (informational; inline copy in those apps has no message files yet)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = resolve(HERE, "..");

// Devanagari has no \b: a Hindi term must not continue a Devanagari word ("डर" in "ऑर्डर").
const NB = "(?<![\\u0900-\\u097F])";

/** Banned claims. Each rule: id, language, regular expression (case-insensitive). */
export const RULES = [
  { id: "guarantee", lang: "en", re: /\bguarantee(?:d|s|ing)?\b/i },
  { id: "hundred_percent", lang: "any", re: /\b100\s?(?:%|percent\b)|\bhundred per\s?cent\b/i },
  { id: "cure", lang: "en", re: /\bcur(?:e|es|ed|ing)\b/i },
  { id: "miracle", lang: "en", re: /\bmiracles?\b|\bmiraculous(?:ly)?\b/i },
  {
    id: "instant_results",
    lang: "en",
    re: /\binstant(?:ly)?\s+(?:results?|relief|solutions?|success|effect)\b/i,
  },
  {
    id: "assured_results",
    lang: "en",
    re: /\b(?:assured|sure[- ]shot|certain)\s+(?:results?|success|outcomes?)\b|\b(?:permanent|lifetime)\s+solutions?\b|\bsolves?\s+all\s+(?:your\s+)?problems\b/i,
  },
  {
    id: "dosha_removal",
    lang: "en",
    re: /\bremov(?:e|es|ing|al of)\s+(?:all\s+)?(?:your\s+)?(?:doshas?|bad karma)\b|\bdosha?\s+(?:removal|nivaran)\b/i,
  },
  {
    id: "fear",
    lang: "en",
    re: /\bblack magic\b|\bevil eye\b|\bcursed?\b|\bbefore it(?:'s|’s| is) too late\b|\bruin(?:s|ed)? your\b|\bdisaster (?:awaits|is coming)\b|\bdangerous (?:dosha|period|planet)\b|\byou will (?:suffer|lose everything)\b/i,
  },
  {
    id: "gemstone_sale",
    lang: "en",
    re: /\b(?:buy|order|wear|purchase|shop)\s+(?:a\s+|an\s+|your\s+|this\s+|our\s+)?(?:lucky\s+|certified\s+)?(?:gem|gemstone|ratna|rudraksha|yantra)s?\b|\blucky\s+(?:gem)?stones?\b|\bcertified\s+gemstones?\b/i,
  },
  { id: "guarantee", lang: "hi", re: new RegExp(`${NB}(?:गारंटी|गारन्टी|गॅरंटी)`) },
  { id: "cure", lang: "hi", re: new RegExp(`${NB}इलाज`) },
  { id: "miracle", lang: "hi", re: new RegExp(`${NB}चमत्कार`) },
  {
    id: "assured_results",
    lang: "hi",
    re: new RegExp(`${NB}(?:शर्तिया|पक्का\\s+(?:इलाज|परिणाम|फल))`),
  },
  {
    id: "instant_results",
    lang: "hi",
    re: new RegExp(`${NB}(?:तुरंत|तुरन्त|फ़ौरन|फौरन)\\s+(?:परिणाम|लाभ|समाधान|फल|असर)`),
  },
  {
    id: "dosha_removal",
    lang: "hi",
    re: new RegExp(
      `${NB}(?:(?:सभी|सारे|सब)\\s+दोष(?:ों)?\\s+(?:दूर|ख़त्म|खत्म|समाप्त|नष्ट)|दोष\\s*(?:निवारण|मुक्ति))`,
    ),
  },
  {
    id: "fear",
    lang: "hi",
    re: new RegExp(
      `${NB}(?:काला\\s+जादू|बुरी\\s+(?:नज़र|नजर)|श्राप|शाप|सर्वनाश|बर्बाद|अनिष्ट\\s+होगा)`,
    ),
  },
  {
    id: "gemstone_sale",
    lang: "hi",
    re: new RegExp(`${NB}(?:रत्न|नग)\\s*(?:ख़रीद|खरीद|पहनें|पहनिए|धारण\\s+करें)`),
  },
];

/** Every banned-claim hit in one string: rule id, the matched text and its position. */
export function scanText(text) {
  const hits = [];
  for (const rule of RULES) {
    const re = new RegExp(
      rule.re.source,
      rule.re.flags.includes("g") ? rule.re.flags : `${rule.re.flags}g`,
    );
    for (const m of text.matchAll(re))
      hits.push({ rule: rule.id, match: m[0], index: m.index ?? 0 });
  }
  return hits.sort((a, b) => a.index - b.index);
}

/** Leaf strings of a JSON value with dotted key paths; keys starting with "$" are not copy. */
export function jsonStrings(value, prefix = "") {
  if (typeof value === "string") return [{ key: prefix, text: value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => jsonStrings(v, `${prefix}[${i}]`));
  if (value && typeof value === "object")
    return Object.entries(value)
      .filter(([k]) => !k.startsWith("$"))
      .flatMap(([k, v]) => jsonStrings(v, prefix ? `${prefix}.${k}` : k));
  return [];
}

/** Quoted string literals and JSX text on one source line (comments are skipped). */
export function sourceStrings(line) {
  const t = line.trim();
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return [];
  const out = [];
  for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g))
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  for (const m of line.matchAll(/>([^<>{}]+)</g)) out.push(m[1]);
  return out;
}

/** True when an allow-list entry covers this hit (phrase around the match, file, key). */
/** `file` in an allow entry: an exact path, or a pattern where `*` matches within a folder. */
export function fileMatches(pattern, file) {
  if (!pattern.includes("*")) return pattern === file;
  const re = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${re}$`).test(file);
}

export function allowedBy(entry, hit) {
  if (entry.file && !fileMatches(entry.file, hit.file)) return false;
  if (entry.key && entry.key !== hit.key) return false;
  if (entry.rule && entry.rule !== hit.rule) return false;
  // No phrase: the whole file (or key) is allowed, e.g. files that list banned claims on purpose.
  if (!entry.phrase) return Boolean(entry.file);
  const hay = hit.text.toLowerCase();
  const phrase = entry.phrase.toLowerCase();
  for (let i = hay.indexOf(phrase); i >= 0; i = hay.indexOf(phrase, i + 1))
    if (i <= hit.index && hit.index + hit.match.length <= i + phrase.length) return true;
  return false;
}

function walk(dir, exts) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out.sort();
}

/** The files the check reads, relative to the repository root. */
export function targets(root, { source = false } = {}) {
  const apps = existsSync(join(root, "apps")) ? readdirSync(join(root, "apps")).sort() : [];
  const files = [];
  for (const app of apps) {
    files.push(...walk(join(root, "apps", app, "messages"), [".json"]));
    files.push(...walk(join(root, "apps", app, "src", "content"), [".json", ".md", ".txt"]));
  }
  for (const f of ["data/marketplace/remedies.json", "data/marketplace/products.json"])
    if (existsSync(join(root, f))) files.push(join(root, f));
  if (source)
    for (const app of ["admin", "astrologer"])
      files.push(...walk(join(root, "apps", app, "src"), [".ts", ".tsx"]));
  return files.map((f) => relative(root, f).split(sep).join("/"));
}

export function loadAllowList(file) {
  if (!existsSync(file)) return [];
  const body = JSON.parse(readFileSync(file, "utf8"));
  const list = Array.isArray(body) ? body : (body.allow ?? []);
  for (const e of list)
    if (!e.reason || typeof e.reason !== "string")
      throw new Error(`allow-list entry without a reason: ${JSON.stringify(e)}`);
  return list;
}

/** Scan the repository: hits not covered by the allow-list, and allow entries never used. */
export function check(root = DEFAULT_ROOT, opts = {}) {
  const allow = opts.allow ?? loadAllowList(join(root, "scripts", "claims-check", "allow.json"));
  const used = new Set();
  const hits = [];
  const files = targets(root, opts);
  for (const file of files) {
    const raw = readFileSync(join(root, file), "utf8");
    const units = file.endsWith(".json")
      ? jsonStrings(JSON.parse(raw)).map((u) => ({ ...u, where: `${file}:${u.key}` }))
      : raw.split("\n").flatMap((line, i) =>
          (/\.tsx?$/.test(file) ? sourceStrings(line) : [line]).map((text) => ({
            key: undefined,
            line: i + 1,
            text,
            where: `${file}:${i + 1}`,
          })),
        );
    for (const u of units)
      for (const h of scanText(u.text)) {
        const hit = { ...h, file, key: u.key, line: u.line, text: u.text, where: u.where };
        const entry = allow.find((e) => allowedBy(e, hit));
        if (entry) used.add(entry);
        else hits.push(hit);
      }
  }
  // An entry for a file this run did not read (e.g. source files without --source) is not stale.
  const unused = allow.filter(
    (e) => !used.has(e) && (!e.file || files.some((f) => fileMatches(e.file, f))),
  );
  return { files, hits, unused };
}

function context(hit, width = 50) {
  const start = Math.max(0, hit.index - width);
  const end = Math.min(hit.text.length, hit.index + hit.match.length + width);
  return `${start > 0 ? "…" : ""}${hit.text.slice(start, end)}${end < hit.text.length ? "…" : ""}`;
}

function main(argv) {
  const rootArg = argv.indexOf("--root");
  const root = rootArg >= 0 ? resolve(argv[rootArg + 1]) : DEFAULT_ROOT;
  const source = argv.includes("--source");
  const { files, hits, unused } = check(root, { source });
  for (const h of hits) console.log(`${h.where}: [${h.rule}] "${h.match}" in "${context(h)}"`);
  for (const e of unused)
    console.warn(`claims-check: allow-list entry no longer used: ${JSON.stringify(e.phrase ?? e)}`);
  console.log(`claims-check: ${files.length} files, ${hits.length} banned claim(s)`);
  if (hits.length) {
    console.log(
      "Reword the copy, or add an entry with a reason to scripts/claims-check/allow.json.",
    );
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2));
