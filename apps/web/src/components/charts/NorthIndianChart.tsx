import { ChartFrame, GrahaStack } from "./ChartFrame";
import { CHART_LABELS } from "./labels";
import { chartLayout, chartSummary, grahaLabel } from "./layout";
import type { ChartProps } from "./types";

type Pt = [number, number];

// Fixed house geometry in a 400×400 box. House 1 is the top inner diamond; houses run
// counter-clockwise. `label` places the grahas, `num` the sign number (near the inner vertex).
const HOUSES: { poly: Pt[]; label: Pt; num: Pt }[] = [
  {
    poly: [
      [200, 0],
      [300, 100],
      [200, 200],
      [100, 100],
    ],
    label: [200, 95],
    num: [200, 178],
  },
  {
    poly: [
      [0, 0],
      [200, 0],
      [100, 100],
    ],
    label: [100, 32],
    num: [100, 80],
  },
  {
    poly: [
      [0, 0],
      [100, 100],
      [0, 200],
    ],
    label: [36, 100],
    num: [80, 100],
  },
  {
    poly: [
      [0, 200],
      [100, 100],
      [200, 200],
      [100, 300],
    ],
    label: [95, 200],
    num: [178, 200],
  },
  {
    poly: [
      [0, 200],
      [100, 300],
      [0, 400],
    ],
    label: [36, 300],
    num: [80, 300],
  },
  {
    poly: [
      [0, 400],
      [100, 300],
      [200, 400],
    ],
    label: [100, 368],
    num: [100, 320],
  },
  {
    poly: [
      [200, 400],
      [100, 300],
      [200, 200],
      [300, 300],
    ],
    label: [200, 305],
    num: [200, 222],
  },
  {
    poly: [
      [200, 400],
      [300, 300],
      [400, 400],
    ],
    label: [300, 368],
    num: [300, 320],
  },
  {
    poly: [
      [400, 400],
      [300, 300],
      [400, 200],
    ],
    label: [364, 300],
    num: [320, 300],
  },
  {
    poly: [
      [400, 200],
      [300, 300],
      [200, 200],
      [300, 100],
    ],
    label: [305, 200],
    num: [222, 200],
  },
  {
    poly: [
      [400, 200],
      [300, 100],
      [400, 0],
    ],
    label: [364, 100],
    num: [320, 100],
  },
  {
    poly: [
      [400, 0],
      [300, 100],
      [200, 0],
    ],
    label: [300, 32],
    num: [300, 80],
  },
];

/** North Indian (diamond) chart: houses are fixed, signs move. Each house shows its sign number
 * (1 = Aries). Without a birth time it falls back to a Moon chart and says so. */
export function NorthIndianChart({ data, locale, title }: ChartProps) {
  const l = CHART_LABELS[locale];
  const layout = chartLayout(data);
  const name =
    title ?? (layout.mode === "lagna" ? l.northTitle : `${l.northTitle}: ${l.moonChart}`);

  return (
    <ChartFrame
      kind="north"
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
      <g stroke="var(--color-primary)" strokeWidth="1.5" fill="none">
        <path d="M0 0 L400 400 M400 0 L0 400" />
        <path d="M200 0 L400 200 L200 400 L0 200 Z" />
      </g>
      {layout.houses.map((h, i) => {
        const geo = HOUSES[i]!;
        return (
          <g key={h.house} data-house={h.house} data-sign={h.signIndex}>
            <text
              x={geo.num[0]}
              y={geo.num[1]}
              fontSize={13}
              fill="var(--color-muted)"
              textAnchor="middle"
              dominantBaseline="middle"
            >
              {h.signIndex + 1}
            </text>
            <GrahaStack
              x={geo.label[0]}
              y={geo.label[1]}
              labels={h.grahas.map((g) => grahaLabel(g, locale))}
            />
          </g>
        );
      })}
      {layout.mode === "lagna" ? (
        <text
          data-lagna=""
          x={200}
          y={150}
          fontSize={11}
          fontWeight={600}
          fill="var(--color-accent)"
          textAnchor="middle"
        >
          {l.asc}
        </text>
      ) : null}
    </ChartFrame>
  );
}
