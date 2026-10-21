import type { PayoutStatus } from "@astro/shared";
import { PAYOUT_STATUS_LABEL } from "@/lib/earnings";

const STYLE: Record<PayoutStatus, string> = {
  draft: "border border-border",
  approved: "bg-accent text-accent-fg",
  paid: "bg-success text-primary-fg",
  void: "border border-border text-muted",
};

export function PayoutBadge({ status }: { status: PayoutStatus }) {
  return (
    <span className={`rounded-sm px-1.5 py-0.5 text-xs font-medium ${STYLE[status]}`}>
      {PAYOUT_STATUS_LABEL[status]}
    </span>
  );
}
