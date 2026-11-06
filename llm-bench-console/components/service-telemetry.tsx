"use client"

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { PLATFORM_MONITOR_SNIPPET, WINDOWS, type MetricPoint, type ServiceTelemetry, type Workload } from "@/lib/monitor-shared"
import { formatDateTime } from "@/lib/format"
import { TimeSeriesChart, type TimeSeries } from "@/components/time-series-chart"
import { EmptyState } from "@/components/empty-state"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url)
  const body = await r.json()
  if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`)
  return body as T
}

const GIB = 1024 ** 3

/** Series label: container, instance and GPU index, dropping parts that don't vary. */
function seriesLabel(p: MetricPoint, multiInstance: boolean): string {
  const parts = [p.container || "container"]
  if (multiInstance) parts.push(`#${p.instance}`)
  if (p.gpu) parts.push(`gpu${p.gpu}`)
  return parts.join(" ")
}

function buildSeries(points: MetricPoint[], metric: string, scale = 1, suffix = "", dashed = false): TimeSeries[] {
  const rows = points.filter((p) => p.metric === metric)
  const multiInstance = new Set(rows.map((p) => p.instance)).size > 1
  const map = new Map<string, TimeSeries>()
  for (const p of rows) {
    const key = `${metric}|${p.instance}|${p.container}|${p.gpu}`
    if (!map.has(key)) map.set(key, { key, name: seriesLabel(p, multiInstance) + suffix, points: [], dashed })
    map.get(key)!.points.push({ ts: p.ts, value: p.value * scale })
  }
  return Array.from(map.values())
}

type Panel = { title: string; unit: string; usage: string; limit?: string; scale?: number; yMax?: number }

const PANELS: Panel[] = [
  { title: "GPU utilization", unit: "%", usage: "container.gpu.utilization", scale: 100, yMax: 100 },
  { title: "GPU memory", unit: " GiB", usage: "container.gpu.memory.usage", limit: "container.gpu.memory.capacity", scale: 1 / GIB },
  { title: "CPU", unit: " cores", usage: "container.cpu.usage", limit: "container.cpu.limit" },
  { title: "Memory", unit: " GiB", usage: "container.memory.usage", limit: "container.memory.limit", scale: 1 / GIB },
  { title: "Notebook CPU utilization", unit: "%", usage: "snowflake.notebook.cpu.utilization_ratio", scale: 100 },
  { title: "Notebook memory utilization", unit: "%", usage: "snowflake.notebook.memory.utilization_ratio", scale: 100 },
  { title: "Container restarts", unit: "", usage: "container.restarts" },
  { title: "Ingress connections", unit: "", usage: "network.ingress.connections.active" },
]

/** Peak of the latest value per series — "how hot is it now". */
function latestPeak(points: MetricPoint[], metric: string): number | null {
  const rows = points.filter((p) => p.metric === metric)
  if (!rows.length) return null
  const last = rows.reduce((m, p) => (p.ts > m ? p.ts : m), "")
  return Math.max(...rows.filter((p) => p.ts === last).map((p) => p.value))
}

function Summary({ points }: { points: MetricPoint[] }) {
  const gpu = latestPeak(points, "container.gpu.utilization")
  const cpu = latestPeak(points, "container.cpu.usage")
  const cpuLimit = latestPeak(points, "container.cpu.limit")
  const mem = latestPeak(points, "container.memory.usage")
  const restarts = latestPeak(points, "container.restarts")
  const items = [
    gpu !== null && { label: "GPU util (latest, max GPU)", value: `${(gpu * 100).toFixed(0)}%` },
    cpu !== null && { label: "CPU (latest, max container)", value: `${cpu.toFixed(2)}${cpuLimit ? ` / ${cpuLimit}` : ""} cores` },
    mem !== null && { label: "Memory (latest, max container)", value: `${(mem / GIB).toFixed(1)} GiB` },
    restarts !== null && { label: "Restarts", value: String(restarts) },
  ].filter(Boolean) as { label: string; value: string }[]
  if (!items.length) return null
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {items.map((i) => (
        <div key={i.label} className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">{i.label}</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">{i.value}</p>
        </div>
      ))}
    </div>
  )
}

export function ServiceTelemetryPanel({ workload }: { workload: Workload }) {
  const [hours, setHours] = useState(6)
  const qs = new URLSearchParams({ database: workload.database, schema: workload.schema, name: workload.name, hours: String(hours) })
  const { data, error, isPending, isFetching } = useQuery({
    queryKey: ["monitor-service", workload.database, workload.schema, workload.name, hours],
    queryFn: () => fetchJson<ServiceTelemetry>(`/api/monitor/service?${qs}`),
    refetchInterval: 60000,
  })
  const points = data?.metrics.data ?? []
  const panels = PANELS.map((p) => ({
    ...p,
    series: [
      ...buildSeries(points, p.usage, p.scale ?? 1),
      ...(p.limit ? buildSeries(points, p.limit, p.scale ?? 1, " limit", true) : []),
    ],
  })).filter((p) => p.series.some((s) => !s.dashed))

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <div className="min-w-0">
          <CardTitle className="truncate text-base">
            {workload.name} <Badge variant="outline" className="ml-1 align-middle">{workload.kind}</Badge>
          </CardTitle>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {workload.database}.{workload.schema} · pool {workload.pool || "—"} · {workload.status}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {isFetching && !isPending && <span className="mr-2 text-xs text-muted-foreground">refreshing…</span>}
          {WINDOWS.map((w) => (
            <Button key={w.hours} size="sm" variant={w.hours === hours ? "default" : "outline"} onClick={() => setHours(w.hours)}>
              {w.label}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {isPending ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-56" />
            <Skeleton className="h-56" />
          </div>
        ) : error ? (
          <EmptyState variant="error" title="Could not load telemetry" description={(error as Error).message} />
        ) : (
          <>
            {data.metrics.error ? (
              <EmptyState variant="error" title="Could not read metrics" description={data.metrics.error} />
            ) : panels.length === 0 ? (
              <div className="space-y-3">
                <EmptyState
                  title="No platform metrics in this window"
                  description={
                    workload.status === "RUNNING"
                      ? "The service is running but publishes no metrics. Add platformMonitor to its spec (ALTER SERVICE … FROM SPECIFICATION) to collect CPU / memory / GPU."
                      : "The service was not running in this window, or platformMonitor is not enabled in its spec."
                  }
                />
                <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs">{PLATFORM_MONITOR_SNIPPET}</pre>
              </div>
            ) : (
              <>
                <Summary points={points} />
                <div className="grid gap-6 lg:grid-cols-2">
                  {panels.map((p) => (
                    <div key={p.title} className="min-w-0 space-y-1">
                      <p className="text-sm font-medium">{p.title}</p>
                      <TimeSeriesChart series={p.series} unit={p.unit} spanHours={hours} yMax={p.yMax} />
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  {data.bucketMinutes}-minute averages from {"<service>"}!SPCS_GET_METRICS. Dashed lines are spec limits / GPU capacity.
                </p>
              </>
            )}

            <div className="space-y-2">
              <p className="text-sm font-medium">Platform events</p>
              {data.events.error ? (
                <EmptyState variant="error" title="Could not read events" description={data.events.error} />
              ) : data.events.data.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No platform events in this window. Events are recorded only when LOG_EVENT_LEVEL is INFO or ERROR on the service,
                  schema, database or account.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Time</TableHead>
                      <TableHead>Event</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Message</TableHead>
                      <TableHead>Instance / container</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.events.data.map((e, i) => (
                      <TableRow key={i}>
                        <TableCell className="whitespace-nowrap text-xs">{formatDateTime(e.ts)}</TableCell>
                        <TableCell className="font-mono text-xs">{e.name}</TableCell>
                        <TableCell>
                          <Badge variant={e.severity === "ERROR" ? "destructive" : "outline"}>{e.status || e.severity}</Badge>
                        </TableCell>
                        <TableCell className="max-w-md text-xs">{e.message}</TableCell>
                        <TableCell className="font-mono text-xs">
                          {[e.instance, e.container].filter(Boolean).join(" / ")}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
