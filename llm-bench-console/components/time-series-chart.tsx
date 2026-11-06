"use client"

import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { CHART_COLORS, CHART_THEME, ChartTooltip } from "@/components/chart-utils"

export type TimeSeries = { key: string; name: string; points: { ts: string; value: number }[]; dashed?: boolean }

function tickTime(ts: string, spanHours: number): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  return spanHours > 24
    ? d.toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit" })
    : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}

/** Metric over time, one line per series; dashed series are used for limits and requests. */
export function TimeSeriesChart({
  series,
  unit,
  spanHours,
  yMax,
}: {
  series: TimeSeries[]
  unit: string
  spanHours: number
  yMax?: number
}) {
  const stamps = Array.from(new Set(series.flatMap((s) => s.points.map((p) => p.ts)))).sort()
  const data = stamps.map((ts) => {
    const row: Record<string, string | number | null> = { ts }
    for (const s of series) {
      const p = s.points.find((x) => x.ts === ts)
      row[s.key] = p ? Math.round(p.value * 100) / 100 : null
    }
    return row
  })
  return (
    <div className="h-56 w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid stroke={CHART_THEME.grid} vertical={false} />
          <XAxis
            dataKey="ts"
            tick={CHART_THEME.tick}
            axisLine={false}
            tickLine={false}
            minTickGap={40}
            tickFormatter={(v) => tickTime(String(v), spanHours)}
          />
          <YAxis
            tick={CHART_THEME.tick}
            axisLine={false}
            tickLine={false}
            width={56}
            unit={unit}
            domain={[0, yMax ?? "auto"]}
          />
          <Tooltip
            content={({ active, payload, label }) => (
              <ChartTooltip
                active={active}
                payload={payload as never}
                label={label ? new Date(String(label)).toLocaleString() : undefined}
              />
            )}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {series.map((s, i) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.name}
              stroke={CHART_COLORS[i % CHART_COLORS.length]}
              strokeWidth={s.dashed ? 1.5 : 2}
              strokeDasharray={s.dashed ? "5 4" : undefined}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
