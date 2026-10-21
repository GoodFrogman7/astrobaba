export type ActionResult =
  { ok: true; message?: string } | { ok: false; error: string; errors?: string[] };

export const IDLE: ActionResult | null = null;
