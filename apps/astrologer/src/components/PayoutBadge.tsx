import type { PayoutStatus } from "@astro/shared";
import { PAYOUT_STATUS_LABEL } from "@/lib/earnings";

const STYLE: Record<string, string> = {
  draft: "border border-border",
  approved: "bg-accent text-accent-fg",
  paid: "bg-success text-primary-fg",
  void: "border border-border text-muted",
};

export function PayoutBadge({ status }: { status: PayoutStatus | string }) {
  return (
    <span
      className={`rounded-sm px-1.5 py-0.5 text-xs font-medium ${STYLE[status] ?? "border border-border"}`}
    >
      {PAYOUT_STATUS_LABEL[status as PayoutStatus] ?? status}
    </span>
  );
}
