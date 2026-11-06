"use client"

import Link from "next/link"
import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Boxes, Coins, Cpu, Server } from "lucide-react"
import type { Identity, Overview, Pool, PoolCredits, Workload, WorkloadKind } from "@/lib/monitor-shared"
import { formatNumber, formatRelative } from "@/lib/format"
import { CHART_COLORS, CHART_THEME, ChartTooltip } from "@/components/chart-utils"
import { PageHeader } from "@/components/page-header"
import { StatCard, StatCardSkeleton } from "@/components/stat-card"
import { EmptyState } from "@/components/empty-state"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

export async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url)
  const body = await r.json()
  if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`)
  return body as T
}

export function useOverview(days: number) {
  return useQuery({
    queryKey: ["monitor-overview", days],
    queryFn: () => fetchJson<Overview>(`/api/monitor?days=${days}`),
    refetchInterval: 30000,
  })
}

const ACTIVE_STATES = ["ACTIVE", "IDLE", "STARTING", "RESIZING"]
const RUNNING_STATUSES = ["RUNNING", "READY", "PENDING", "UPGRADING", "RESUMING"]

export function PoolStateBadge({ state }: { state: string }) {
  const variant = state === "ACTIVE" ? "success" : state === "IDLE" || state === "SUSPENDED" ? "outline" : "warning"
  return <Badge variant={variant}>{state}</Badge>
}

export function WorkloadStatusBadge({ status }: { status: string }) {
  const variant =
    status === "RUNNING" || status === "READY" || status === "DONE"
      ? "success"
      : status === "FAILED" || status === "INTERNAL_ERROR"
        ? "destructive"
        : status === "SUSPENDED" || status === "CANCELLED"
          ? "outline"
          : "warning"
  return <Badge variant={variant}>{status}</Badge>
}

export function IdentityNote({ identity }: { identity: Identity }) {
  const text = {
    caller: "Showing what your own role can see (caller's rights).",
    service: "Some sections use the app's role because your role lacks the grants.",
    dev: "Local dev: queries run as the developer connection.",
  }[identity]
  return <p className="text-xs text-muted-foreground">{text}</p>
}

function SectionError({ error }: { error: string }) {
  return <EmptyState variant="error" title="Could not load this section" description={error} />
}

function CreditsChart({ credits }: { credits: PoolCredits[] }) {
  const pools = Array.from(new Set(credits.map((c) => c.pool))).sort()
  const days = Array.from(new Set(credits.map((c) => c.day))).sort()
  const data = days.map((day) => {
    const row: Record<string, string | number> = { day }
    for (const p of pools) row[p] = Math.round((credits.find((c) => c.day === day && c.pool === p)?.credits ?? 0) * 100) / 100
    return row
  })
  return (
    <div className="h-64 w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid stroke={CHART_THEME.grid} vertical={false} />
          <XAxis dataKey="day" tick={CHART_THEME.tick} axisLine={false} tickLine={false} />
          <YAxis tick={CHART_THEME.tick} axisLine={false} tickLine={false} width={48} />
          <Tooltip content={<ChartTooltip />} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {pools.map((p, i) => (
            <Bar key={p} dataKey={p} stackId="c" fill={CHART_COLORS[i % CHART_COLORS.length]} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function kindCounts(workloads: Workload[]): [WorkloadKind, number, number][] {
  const m = new Map<WorkloadKind, [number, number]>()
  for (const w of workloads) {
    const c = m.get(w.kind) ?? [0, 0]
    c[0]++
    if (RUNNING_STATUSES.includes(w.status)) c[1]++
    m.set(w.kind, c)
  }
  return Array.from(m.entries()).map(([k, [t, r]]) => [k, t, r])
}

function PoolsTable({ pools, workloads, credits }: { pools: Pool[]; workloads: Workload[]; credits: PoolCredits[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Pool</TableHead>
          <TableHead>State</TableHead>
          <TableHead>Instance family</TableHead>
          <TableHead className="text-right">Nodes (active / max)</TableHead>
          <TableHead>Workloads</TableHead>
          <TableHead className="text-right">Credits (window)</TableHead>
          <TableHead>Resumed</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {pools.map((p) => {
          const ws = workloads.filter((w) => w.pool === p.name)
          const running = ws.filter((w) => RUNNING_STATUSES.includes(w.status)).length
          const cr = credits.filter((c) => c.pool === p.name).reduce((s, c) => s + c.credits, 0)
          return (
            <TableRow key={p.name}>
              <TableCell className="font-medium">
                <Link href={`/monitor/pools/${encodeURIComponent(p.name)}`} className="hover:underline">
                  {p.name}
                </Link>
              </TableCell>
              <TableCell>
                <PoolStateBadge state={p.state} />
              </TableCell>
              <TableCell>
                <span className="font-mono text-xs">{p.instanceFamily}</span>
                {p.isGpu && <Badge variant="secondary" className="ml-2">GPU</Badge>}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {p.activeNodes} / {p.maxNodes}
                {p.targetNodes !== p.activeNodes && <span className="text-xs text-muted-foreground"> → {p.targetNodes}</span>}
              </TableCell>
              <TableCell className="text-sm">
                {ws.length === 0 ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <>
                    {running} running / {ws.length}
                    <span className="ml-1 text-xs text-muted-foreground">
                      ({Array.from(new Set(ws.map((w) => w.kind))).join(", ")})
                    </span>
                  </>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">{cr ? formatNumber(cr) : "—"}</TableCell>
              <TableCell className="text-xs text-muted-foreground">{p.resumedOn ? formatRelative(p.resumedOn) : "—"}</TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

export function MonitorView() {
  const [days, setDays] = useState(7)
  const { data, error, isPending } = useOverview(days)
  const pools = data?.pools.data ?? []
  const workloads = data?.workloads.data ?? []
  const credits = data?.credits.data ?? []
  const totalCredits = credits.reduce((s, c) => s + c.credits, 0)
  const activePools = pools.filter((p) => ACTIVE_STATES.includes(p.state))
  const gpuNodes = pools.filter((p) => p.isGpu).reduce((s, p) => s + p.activeNodes, 0)
  const running = workloads.filter((w) => RUNNING_STATUSES.includes(w.status))

  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <PageHeader
        eyebrow="Snowpark Container Services"
        title="Compute monitor"
        description="Compute pools, services, jobs, notebooks and container Streamlit apps in one place: inventory and credits from SHOW / ACCOUNT_USAGE, CPU / memory / GPU from platform metrics."
        actions={
          <div className="flex items-center gap-1">
            {[1, 7, 30].map((d) => (
              <Button key={d} size="sm" variant={d === days ? "default" : "outline"} onClick={() => setDays(d)}>
                {d}d
              </Button>
            ))}
          </div>
        }
      />
      {data && <IdentityNote identity={data.identity} />}
      {error && <EmptyState variant="error" title="Could not load monitor" description={(error as Error).message} />}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {isPending ? (
          Array.from({ length: 4 }, (_, i) => <StatCardSkeleton key={i} />)
        ) : (
          <>
            <StatCard label="Active pools" value={`${activePools.length} / ${pools.length}`} hint="ACTIVE, IDLE or resizing" icon={Boxes} />
            <StatCard label="Active GPU nodes" value={gpuNodes} hint="across GPU instance families" icon={Cpu} />
            <StatCard
              label="Running workloads"
              value={`${running.length} / ${workloads.length}`}
              hint={kindCounts(running).map(([k, n]) => `${n} ${k}`).join(" · ") || "none running"}
              icon={Server}
            />
            <StatCard label={`SPCS credits (${days}d)`} value={formatNumber(totalCredits)} hint="ACCOUNT_USAGE, up to ~3h latency" icon={Coins} />
          </>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Compute pools</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isPending ? (
            <div className="p-6">
              <Skeleton className="h-32" />
            </div>
          ) : data?.pools.error ? (
            <div className="p-6">
              <SectionError error={data.pools.error} />
            </div>
          ) : pools.length === 0 ? (
            <div className="p-6">
              <EmptyState title="No compute pools visible" description="Your role has no privileges on any compute pool." />
            </div>
          ) : (
            <PoolsTable pools={pools} workloads={workloads} credits={credits} />
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Daily credits by pool</CardTitle>
          </CardHeader>
          <CardContent>
            {isPending ? (
              <Skeleton className="h-64" />
            ) : data?.credits.error ? (
              <SectionError error={data.credits.error} />
            ) : credits.length === 0 ? (
              <EmptyState title="No SPCS credits in this window" />
            ) : (
              <CreditsChart credits={credits} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Notebook usage (container runtime)</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isPending ? (
              <div className="p-6">
                <Skeleton className="h-48" />
              </div>
            ) : data?.notebooks.error ? (
              <div className="p-6">
                <SectionError error={data.notebooks.error} />
              </div>
            ) : (data?.notebooks.data ?? []).length === 0 ? (
              <div className="p-6">
                <EmptyState title="No notebook runtime in this window" />
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Notebook</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>Pool</TableHead>
                    <TableHead className="text-right">Hours</TableHead>
                    <TableHead className="text-right">Credits</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data!.notebooks.data.map((n, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-medium">{n.notebook}</TableCell>
                      <TableCell>{n.user}</TableCell>
                      <TableCell className="font-mono text-xs">{n.pool}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(n.hours, 1)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(n.credits)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">All workloads</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isPending ? (
            <div className="p-6">
              <Skeleton className="h-32" />
            </div>
          ) : data?.workloads.error ? (
            <div className="p-6">
              <SectionError error={data.workloads.error} />
            </div>
          ) : (
            <WorkloadsTable workloads={workloads} />
          )}
        </CardContent>
      </Card>
    </main>
  )
}

export function WorkloadsTable({ workloads, onSelect, selected }: { workloads: Workload[]; onSelect?: (w: Workload) => void; selected?: string }) {
  if (workloads.length === 0) {
    return (
      <div className="p-6">
        <EmptyState title="No workloads visible" />
      </div>
    )
  }
  const sorted = [...workloads].sort(
    (a, b) => Number(RUNNING_STATUSES.includes(b.status)) - Number(RUNNING_STATUSES.includes(a.status)) || a.name.localeCompare(b.name),
  )
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Pool</TableHead>
          <TableHead className="text-right">Instances</TableHead>
          <TableHead>Owner</TableHead>
          {onSelect && <TableHead />}
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((w) => {
          const id = `${w.database}.${w.schema}.${w.name}`
          return (
            <TableRow key={id} data-state={selected === id ? "selected" : undefined}>
              <TableCell>
                <div className="font-medium">{w.name}</div>
                <div className="font-mono text-xs text-muted-foreground">
                  {w.database}.{w.schema}
                  {w.managedBy && ` · ${w.managedBy}`}
                </div>
              </TableCell>
              <TableCell>
                <Badge variant="outline">{w.kind}</Badge>
              </TableCell>
              <TableCell>
                <WorkloadStatusBadge status={w.status} />
              </TableCell>
              <TableCell className="font-mono text-xs">
                {w.pool ? (
                  <Link href={`/monitor/pools/${encodeURIComponent(w.pool)}`} className="hover:underline">
                    {w.pool}
                  </Link>
                ) : (
                  "—"
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {w.currentInstances ?? "—"}
                {w.maxInstances !== null && <span className="text-xs text-muted-foreground"> / {w.maxInstances}</span>}
              </TableCell>
              <TableCell className="text-xs">{w.owner ?? "—"}</TableCell>
              {onSelect && (
                <TableCell className="text-right">
                  <Button size="sm" variant={selected === id ? "default" : "outline"} onClick={() => onSelect(w)}>
                    Metrics
                  </Button>
                </TableCell>
              )}
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
