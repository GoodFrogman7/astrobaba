import flagsFile from "../flags/flags.json" with { type: "json" };

type FlagFile = Record<string, { default: boolean; description: string }>;
const FLAGS = flagsFile as FlagFile;

export type FlagName = keyof typeof flagsFile;
export const FLAG_NAMES = Object.keys(FLAGS) as FlagName[];

/**
 * Resolve a flag: env `FLAG_<NAME>` (true/false/1/0) overrides the default in flags.json.
 * Same rule as the Python side (services/api/src/astro_api/flags.py).
 */
export function flagEnabled(
  name: FlagName,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const def = FLAGS[name];
  if (!def) throw new Error(`Unknown flag: ${String(name)}`);
  const raw = env[`FLAG_${String(name).toUpperCase()}`]?.trim().toLowerCase();
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return def.default;
}

export function allFlags(env: Record<string, string | undefined> = process.env) {
  return Object.fromEntries(FLAG_NAMES.map((n) => [n, flagEnabled(n, env)])) as Record<
    FlagName,
    boolean
  >;
}
