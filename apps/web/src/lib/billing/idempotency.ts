/** Idempotency keys for money and session writes (docs/api/billing.md "Idempotency"). */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/**
 * One key per user intent. Asking again for the same intent (a retry after a network error, or
 * a second click) returns the same key, so the API answers with the original result instead of
 * creating a second order or session. A different intent, or `done()`, starts a new key.
 */
export class IntentKeys {
  private intent: string | null = null;
  private key: string | null = null;

  constructor(private readonly make: () => string = newIdempotencyKey) {}

  for(intent: string): string {
    if (this.intent !== intent || !this.key) {
      this.intent = intent;
      this.key = this.make();
    }
    return this.key;
  }

  done(): void {
    this.intent = null;
    this.key = null;
  }
}
