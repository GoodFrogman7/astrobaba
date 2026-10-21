import { ChartFrame, GrahaStack } from "./ChartFrame";
import { CHART_LABELS } from "./labels";
import { chartLayout, chartSummary, grahaLabel } from "./layout";
import type { ChartProps } from "./types";

// Fixed sign cells in a 4×4 grid (row, col), Pisces top-left, running clockwise.
// Index = sign (0 Aries … 11 Pisces).
const CELLS: [number, number][] = [
  [0, 1], // Aries
  [0, 2], // Taurus
  [0, 3], // Gemini
  [1, 3], // Cancer
  [2, 3], // Leo
  [3, 3], // Virgo
  [3, 2], // Libra
  [3, 1], // Scorpio
  [3, 0], // Sagittarius
  [2, 0], // Capricorn
  [1, 0], // Aquarius
  [0, 0], // Pisces
];
const CELL = 100;

/** South Indian chart: signs are fixed, the ascendant's sign is marked with a diagonal. */
export function SouthIndianChart({ data, locale, title }: ChartProps) {
  const l = CHART_LABELS[locale];
  const layout = chartLayout(data);
  const name =
    title ?? (layout.mode === "lagna" ? l.southTitle : `${l.southTitle}: ${l.moonChart}`);
  const bySign = new Map(layout.houses.map((h) => [h.signIndex, h]));

  return (
    <ChartFrame
      kind="south"
      layout={layout}
      locale={locale}
      title={name}
      summary={chartSummary(layout, locale, name)}
      notice={
        layout.mode === "moon" ? `${l.unknownTime}${l.stop} ${l.moonChart}${l.stop}` : undefined
      }
    >
      <rect
        x="1"
        y="1"
        width="398"
        height="398"
        rx="6"
        fill="var(--color-surface)"
        stroke="var(--color-primary)"
        strokeWidth="2"
      />
      {CELLS.map(([row, col], sign) => {
        const x = col * CELL;
        const y = row * CELL;
        const h = bySign.get(sign)!;
        const isLagna = layout.mode === "lagna" && sign === layout.firstSign;
        return (
          <g key={sign} data-house={h.house} data-sign={sign}>
            <rect
              x={x}
              y={y}
              width={CELL}
              height={CELL}
              fill="none"
              stroke="var(--color-primary)"
              strokeWidth="1.5"
            />
            <text x={x + 6} y={y + 14} fontSize={10} fill="var(--color-muted)">
              {l.signShort[sign]}
            </text>
            {isLagna ? (
              <g data-lagna="">
                <path
                  d={`M${x} ${y + 34} L${x + 34} ${y}`}
                  stroke="var(--color-accent)"
                  strokeWidth="2"
                />
                <text
                  x={x + CELL - 6}
                  y={y + 14}
                  fontSize={10}
                  fontWeight={600}
                  fill="var(--color-accent)"
                  textAnchor="end"
                >
                  {l.asc}
                </text>
              </g>
            ) : null}
            <GrahaStack
              x={x + CELL / 2}
              y={y + CELL / 2 + 8}
              labels={h.grahas.map((g) => grahaLabel(g, locale))}
            />
          </g>
        );
      })}
      <text
        x={200}
        y={205}
        fontSize={16}
        fontWeight={600}
        fill="var(--color-fg)"
        textAnchor="middle"
      >
        {l.rashi}
      </text>
    </ChartFrame>
  );
}
