import "server-only";

/**
 * Development preview data, generated from the astro engine by scripts/report-fixtures.mjs.
 * Imported only behind a NODE_ENV check (see load.ts), so production builds never include it.
 */
const FIXTURES: Record<string, () => Promise<{ default: unknown }>> = {
  "fixture-kundli-en": () => import("../../../test/fixtures/report/fixture-kundli-en.json"),
  "fixture-kundli-hi": () => import("../../../test/fixtures/report/fixture-kundli-hi.json"),
  "fixture-kundli-notime-en": () =>
    import("../../../test/fixtures/report/fixture-kundli-notime-en.json"),
  "fixture-matching-en": () => import("../../../test/fixtures/report/fixture-matching-en.json"),
  "fixture-matching-hi": () => import("../../../test/fixtures/report/fixture-matching-hi.json"),
};

export const FIXTURE_IDS = Object.keys(FIXTURES);

export async function loadFixture(id: string): Promise<unknown | null> {
  const load = Object.hasOwn(FIXTURES, id) ? FIXTURES[id] : undefined;
  return load ? (await load()).default : null;
}
