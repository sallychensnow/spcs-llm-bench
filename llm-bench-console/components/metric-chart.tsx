"use client"

import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { CHART_COLORS, CHART_THEME, ChartTooltip } from "@/components/chart-utils"
import type { ResultPoint } from "@/lib/bench-shared"

export type Series = { key: string; name: string; points: ResultPoint[] }

/** One metric vs concurrency, one line per series, with an optional SLA reference line. */
export function MetricChart({
  series,
  metric,
  unit,
  sla,
  slaLabel,
}: {
  series: Series[]
  metric: (p: ResultPoint) => number | null
  unit: string
  sla?: number
  slaLabel?: string
}) {
  const levels = Array.from(new Set(series.flatMap((s) => s.points.map((p) => p.concurrency)))).sort((a, b) => a - b)
  const data = levels.map((c) => {
    const row: Record<string, number | null> = { c }
    for (const s of series) {
      const p = s.points.find((x) => x.concurrency === c)
      const v = p ? metric(p) : null
      row[s.key] = v === null ? null : Math.round(v * 100) / 100
    }
    return row
  })
  return (
    <div className="h-64 w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid stroke={CHART_THEME.grid} vertical={false} />
          <XAxis
            dataKey="c"
            tick={CHART_THEME.tick}
            axisLine={false}
            tickLine={false}
            label={{ value: "concurrency", position: "insideBottomRight", offset: -2, fill: "var(--chart-axis)", fontSize: 11 }}
          />
          <YAxis tick={CHART_THEME.tick} axisLine={false} tickLine={false} width={48} unit={unit} />
          <Tooltip content={<ChartTooltip />} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {sla !== undefined && (
            <ReferenceLine
              y={sla}
              stroke="var(--destructive)"
              strokeDasharray="4 4"
              label={{ value: slaLabel ?? "SLA", fill: "var(--destructive)", fontSize: 11, position: "insideTopLeft" }}
            />
          )}
          {series.map((s, i) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.name}
              stroke={CHART_COLORS[i % CHART_COLORS.length]}
              strokeWidth={2}
              dot={{ r: 3 }}
              connectNulls
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
