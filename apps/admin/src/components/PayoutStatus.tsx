import { statusLabel } from "@/lib/payouts";

const STYLE: Record<string, string> = {
  draft: "border border-border",
  approved: "bg-accent text-accent-fg",
  paid: "bg-success text-primary-fg",
  void: "border border-border text-muted line-through",
};

export function PayoutStatus({ status }: { status: string }) {
  return (
    <span
      className={`rounded-sm px-1.5 py-0.5 text-xs font-medium ${STYLE[status] ?? "border border-border"}`}
    >
      {statusLabel(status)}
    </span>
  );
}
