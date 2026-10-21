import type { RechargeOrder } from "./types";

/**
 * Wait for the webhook to settle a recharge order. The browser never credits anything: it only
 * reads the order until the API says `paid` or `failed`, backing off from 1 s to 5 s, and gives
 * up after `maxMs` (the UI then says the payment is still being confirmed).
 */
export function pollDelay(attempt: number): number {
  return Math.min(5000, 1000 + attempt * 500);
}

export async function pollOrder(
  get: () => Promise<RechargeOrder | null>,
  {
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    maxMs = 120_000,
    cancelled = () => false,
  }: { sleep?: (ms: number) => Promise<void>; maxMs?: number; cancelled?: () => boolean } = {},
): Promise<{ order: RechargeOrder | null; settled: boolean }> {
  let waited = 0;
  let last: RechargeOrder | null = null;
  for (let attempt = 0; !cancelled(); attempt++) {
    const order = await get();
    if (order) last = order;
    if (order && order.status !== "created") return { order, settled: true };
    const d = pollDelay(attempt);
    if (waited + d > maxMs) break;
    await sleep(d);
    waited += d;
  }
  return { order: last, settled: false };
}
