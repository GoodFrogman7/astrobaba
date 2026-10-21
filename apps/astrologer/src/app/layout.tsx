import { BRAND_NAME, DISCLAIMER } from "@astro/shared";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: `Console | ${BRAND_NAME} for astrologers`,
    template: `%s | ${BRAND_NAME} for astrologers`,
  },
  robots: { index: false, follow: false, nocache: true },
};

const NAV = [
  { href: "/", label: "Console" },
  { href: "/history", label: "History" },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-dvh flex-col font-sans antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:bg-surface focus:px-3 focus:py-2"
        >
          Skip to content
        </a>
        <header className="border-b border-border bg-surface">
          <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 px-4 py-3">
            <Link href="/" prefetch={false} className="font-semibold">
              {BRAND_NAME} for astrologers
            </Link>
            <nav aria-label="Console">
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
        <div className="flex-1">{children}</div>
        <footer className="border-t border-border px-4 py-4 text-center text-xs text-muted">
          {DISCLAIMER.en}
        </footer>
      </body>
    </html>
  );
}
