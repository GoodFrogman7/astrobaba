"use server";

/**
 * Server actions for the tools. Birth details go server-to-server to the astro engine and are
 * never logged, put in URLs or sent to analytics.
 */
import { astro, UpstreamError } from "@/lib/upstream";
import type { ActionResult, BirthInput, Dasha, Doshas, Kundli, Match, Numerology } from "./types";
import { toEngineBirth, validateBirth, validateDob, validateName } from "./validate";

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (e instanceof UpstreamError) return { ok: false, code: e.code, message: e.message };
    return { ok: false, code: "unexpected_error" };
  }
}

function invalid(errors: string[]): ActionResult<never> {
  return { ok: false, code: errors[0] ?? "invalid" };
}

export async function computeKundli(birth: BirthInput): Promise<ActionResult<Kundli>> {
  const errors = validateBirth(birth);
  if (errors.length) return invalid(errors);
  return run(() => astro.post<Kundli>("/v1/kundli", { birth: toEngineBirth(birth) }));
}

export async function computeDasha(birth: BirthInput): Promise<ActionResult<Dasha>> {
  const errors = validateBirth(birth);
  if (errors.length) return invalid(errors);
  return run(() => astro.post<Dasha>("/v1/dasha", { birth: toEngineBirth(birth) }));
}

export async function computeDoshas(birth: BirthInput): Promise<ActionResult<Doshas>> {
  const errors = validateBirth(birth);
  if (errors.length) return invalid(errors);
  return run(() => astro.post<Doshas>("/v1/doshas", { birth: toEngineBirth(birth) }));
}

/** Kundli page: chart, dasha and doshas together. Doshas may be gated (503) independently. */
export async function computeFullKundli(
  birth: BirthInput,
): Promise<
  ActionResult<{ kundli: Kundli; dasha: ActionResult<Dasha>; doshas: ActionResult<Doshas> }>
> {
  const kundli = await computeKundli(birth);
  if (!kundli.ok) return kundli;
  const [dasha, doshas] = await Promise.all([computeDasha(birth), computeDoshas(birth)]);
  return { ok: true, data: { kundli: kundli.data, dasha, doshas } };
}

export async function computeMatch(
  partner1: BirthInput,
  partner2: BirthInput,
): Promise<ActionResult<Match>> {
  const errors = [...validateBirth(partner1), ...validateBirth(partner2)];
  if (errors.length) return invalid(errors);
  // The traditional system is defined for a groom and a bride; partner 1 fills the groom role.
  return run(() =>
    astro.post<Match>("/v1/match", {
      groom: toEngineBirth(partner1),
      bride: toEngineBirth(partner2),
    }),
  );
}

export async function computeNumerology(input: {
  name?: string;
  dateOfBirth?: string;
}): Promise<ActionResult<Numerology>> {
  if (input.name !== undefined) {
    const errors = validateName(input.name);
    if (errors.length) return invalid(errors);
  }
  if (input.dateOfBirth !== undefined) {
    const errors = validateDob(input.dateOfBirth);
    if (errors.length) return invalid(errors);
  }
  if (input.name === undefined && input.dateOfBirth === undefined) return invalid(["missing"]);
  return run(() =>
    astro.post<Numerology>("/v1/numerology", {
      name: input.name?.trim() ?? null,
      date_of_birth: input.dateOfBirth ?? null,
      system: "chaldean",
    }),
  );
}
