"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export const NAV = [
  { href: "/", label: "Console" },
  { href: "/schedule", label: "Schedule" },
  { href: "/earnings", label: "Earnings" },
  { href: "/payouts", label: "Payouts" },
  { href: "/reviews", label: "Reviews" },
  { href: "/settings", label: "Settings" },
  { href: "/history", label: "History" },
  { href: "/conduct", label: "Conduct" },
] as const;

export function isCurrent(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/" || pathname.startsWith("/sessions/");
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function NavLinks() {
  const pathname = usePathname() ?? "/";
  return (
    <>
      {NAV.map((n) => {
        const current = isCurrent(n.href, pathname);
        return (
          <li key={n.href}>
            <Link
              href={n.href}
              prefetch={false}
              aria-current={current ? "page" : undefined}
              className={`inline-block py-1.5 hover:underline ${current ? "font-semibold underline underline-offset-4" : ""}`}
            >
              {n.label}
            </Link>
          </li>
        );
      })}
    </>
  );
}
