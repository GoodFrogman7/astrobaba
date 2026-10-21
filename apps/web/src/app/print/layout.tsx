import { BRAND_NAME } from "@astro/shared";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import "../globals.css";
import "@/components/report/report.css";

/**
 * Root layout for print-only pages (docs/api/revenue.md §2.3): no site header, footer, nav,
 * analytics or client providers. Private and never indexed; the light theme is forced because
 * the page is printed to paper.
 */
export const metadata: Metadata = {
  title: `${BRAND_NAME} report`,
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function PrintLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="light">
      <body>{children}</body>
    </html>
  );
}
