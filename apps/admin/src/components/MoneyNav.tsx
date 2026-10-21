import Link from "next/link";
import { formatRupees, formatSignedRupees } from "@/lib/money";

export const MONEY_PAGES = [
  { href: "/money/refunds", label: "Refunds" },
  { href: "/money/free-sessions", label: "Free sessions" },
  { href: "/money/reconciliation", label: "Reconciliation" },
  { href: "/money/wallets", label: "User wallet" },
] as const;

export function MoneyNav({ current }: { current: (typeof MONEY_PAGES)[number]["href"] }) {
  return (
    <nav aria-label="Money" className="mt-4 overflow-x-auto">
      <ul className="flex gap-1 text-sm">
        {MONEY_PAGES.map((p) => (
          <li key={p.href}>
            <Link
              href={p.href}
              prefetch={false}
              aria-current={p.href === current ? "page" : undefined}
              className={`inline-block rounded-sm px-3 py-1.5 whitespace-nowrap ${
                p.href === current ? "bg-primary text-primary-fg" : "border border-border"
              }`}
            >
              {p.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Money is integer paise in code and only becomes ₹ text at display time. */
export function Amount({ paise, signed = false }: { paise: number; signed?: boolean }) {
  return (
    <span className="tabular-nums whitespace-nowrap">
      {signed ? formatSignedRupees(paise) : formatRupees(paise)}
    </span>
  );
}
