import { BRAND_NAME } from "@astro/shared";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: `Admin | ${BRAND_NAME}`, template: `%s | Admin | ${BRAND_NAME}` },
  robots: { index: false, follow: false, nocache: true },
};

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/astrologers", label: "Astrologers" },
  { href: "/reviews", label: "Reviews" },
  { href: "/horoscopes", label: "Horoscopes" },
  { href: "/sessions", label: "Sessions" },
  { href: "/money/refunds", label: "Money" },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh font-sans antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:bg-surface focus:px-3 focus:py-2"
        >
          Skip to content
        </a>
        <header className="border-b border-border bg-surface">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
            <Link href="/" prefetch={false} className="font-semibold">
              {BRAND_NAME} admin
            </Link>
            <nav aria-label="Admin">
              <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {NAV.map((n) => (
                  <li key={n.href}>
                    <Link
                      href={n.href}
                      prefetch={false}
                      className="inline-block py-1.5 hover:underline"
                    >
                      {n.label}
                    </Link>
                  </li>
                ))}
                <li>
                  <form action="/api/auth/logout" method="post">
                    <button className="py-1.5 text-muted hover:underline">Sign out</button>
                  </form>
                </li>
              </ul>
            </nav>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
