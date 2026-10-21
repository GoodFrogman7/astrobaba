import type { ReactNode } from "react";
import type { ChartLayout } from "./layout";
import { houseSummaries } from "./layout";
import type { ChartLocale } from "./types";

/** <figure> wrapper: the SVG is role="img" with a full text summary; the list below is
 * screen-reader only. */
export function ChartFrame({
  layout,
  locale,
  title,
  summary,
  children,
  kind,
  notice,
}: {
  layout: ChartLayout;
  locale: ChartLocale;
  title: string;
  summary: string;
  children: ReactNode;
  kind: "north" | "south";
  /** Visible note above the chart, e.g. that the birth time is unknown. */
  notice?: string;
}) {
  return (
    <figure className="w-full" data-chart={kind} data-mode={layout.mode}>
      {notice ? (
        <p data-unknown-time="" aria-hidden="true" className="mb-2 text-sm font-medium text-accent">
          {notice}
        </p>
      ) : null}
      <svg
        viewBox="0 0 400 400"
        width="100%"
        role="img"
        aria-label={summary}
        className="block h-auto w-full"
        style={{ fontFamily: "inherit" }}
      >
        <title>{title}</title>
        {children}
      </svg>
      <figcaption className="sr-only">
        <ul>
          {houseSummaries(layout, locale).map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}

/** Graha labels stacked around (x, y); more than three go two per row. */
export function GrahaStack({
  x,
  y,
  labels,
  lineHeight = 15,
}: {
  x: number;
  y: number;
  labels: string[];
  lineHeight?: number;
}) {
  const rows: string[][] = [];
  const perRow = labels.length > 3 ? 2 : 1;
  for (let i = 0; i < labels.length; i += perRow) rows.push(labels.slice(i, i + perRow));
  const top = y - ((rows.length - 1) * lineHeight) / 2;
  return (
    <g fontSize={12} fill="var(--color-fg)" textAnchor="middle" dominantBaseline="middle">
      {rows.map((row, i) => (
        <text key={row.join()} x={x} y={top + i * lineHeight} data-graha-row="">
          {row.join("  ")}
        </text>
      ))}
    </g>
  );
}
