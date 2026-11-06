"use client"

import Link from "next/link"
import { useState } from "react"
import { ArrowLeft } from "lucide-react"
import type { Workload } from "@/lib/monitor-shared"
import { formatNumber, formatRelative } from "@/lib/format"
import { IdentityNote, PoolStateBadge, WorkloadsTable, useOverview } from "@/components/monitor-view"
import { ServiceTelemetryPanel } from "@/components/service-telemetry"
import { PageHeader } from "@/components/page-header"
import { EmptyState } from "@/components/empty-state"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

export function PoolDetail({ pool: poolName }: { pool: string }) {
  const { data, error, isPending } = useOverview(7)
  const [selected, setSelected] = useState<Workload | null>(null)
  const pool = data?.pools.data.find((p) => p.name === poolName)
  const workloads = (data?.workloads.data ?? []).filter((w) => w.pool === poolName)
  const credits = (data?.credits.data ?? []).filter((c) => c.pool === poolName).reduce((s, c) => s + c.credits, 0)
  // Default to the first running workload so the page opens on live metrics.
  const active = selected ?? workloads.find((w) => w.status === "RUNNING" || w.status === "READY") ?? workloads[0] ?? null

  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/monitor">
          <ArrowLeft className="h-4 w-4" /> Compute monitor
        </Link>
      </Button>
      <PageHeader
        eyebrow="Compute pool"
        title={poolName}
      />
      {pool && (
        <div className="text-sm text-muted-foreground">
          <div className="flex flex-wrap items-center gap-2">
              <PoolStateBadge state={pool.state} />
              <span className="font-mono text-xs">{pool.instanceFamily}</span>
              {pool.isGpu && <Badge variant="secondary">GPU</Badge>}
              <span className="text-xs">
                nodes {pool.activeNodes} active · {pool.idleNodes} idle · min {pool.minNodes} / max {pool.maxNodes}
              </span>
              <span className="text-xs">· auto-suspend {pool.autoSuspendSecs ?? "—"}s</span>
              <span className="text-xs">· 7d credits {formatNumber(credits)}</span>
              {pool.resumedOn && <span className="text-xs">· resumed {formatRelative(pool.resumedOn)}</span>}
            </div>
        </div>
      )}
      {data && <IdentityNote identity={data.identity} />}
      {error && <EmptyState variant="error" title="Could not load pool" description={(error as Error).message} />}
      {!isPending && !error && !pool && !data?.pools.error && (
        <EmptyState title="Pool not visible" description="It does not exist or your role has no privileges on it." />
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Services, jobs, notebooks and apps on this pool</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isPending ? (
            <div className="p-6">
              <Skeleton className="h-24" />
            </div>
          ) : data?.workloads.error ? (
            <div className="p-6">
              <EmptyState variant="error" title="Could not list workloads" description={data.workloads.error} />
            </div>
          ) : (
            <WorkloadsTable
              workloads={workloads}
              onSelect={setSelected}
              selected={active ? `${active.database}.${active.schema}.${active.name}` : undefined}
            />
          )}
        </CardContent>
      </Card>

      {active && <ServiceTelemetryPanel key={`${active.database}.${active.schema}.${active.name}`} workload={active} />}
    </main>
  )
}
