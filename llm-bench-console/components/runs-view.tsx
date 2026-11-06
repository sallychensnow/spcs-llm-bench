"use client"

import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import { Activity, CheckCircle2, Clock, Play } from "lucide-react"
import { ACTIVE_STATUSES, TEST_INFO, type Run } from "@/lib/bench-shared"
import { formatDateTime, formatDuration, formatRelative } from "@/lib/format"
import { PageHeader } from "@/components/page-header"
import { StatCard, StatCardSkeleton } from "@/components/stat-card"
import { EmptyState } from "@/components/empty-state"
import { RunStatusBadge } from "@/components/run-status-badge"
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

function runDurationMs(run: Run): number | null {
  if (!run.startedAt) return null
  const end = run.finishedAt ? new Date(run.finishedAt) : new Date()
  return end.getTime() - new Date(run.startedAt).getTime()
}

export function RunsView() {
  const { data, error, isPending } = useQuery({
    queryKey: ["runs"],
    queryFn: () => fetchJson<{ runs: Run[] }>("/api/runs"),
    refetchInterval: 15000,
  })
  const runs = data?.runs ?? []
  const active = runs.filter((r) => ACTIVE_STATUSES.includes(r.status))
  const done = runs.filter((r) => r.status === "DONE" || r.status === "DONE_WITH_ERRORS")

  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <PageHeader
        eyebrow="SPCS vLLM capacity benchmark"
        title="Benchmark runs"
        description="One-click capacity tests against registered PoC inference services: baseline latency, concurrency ramp, RAG vs chat token shapes, cold start and replica scaling."
        actions={
          <Button asChild>
            <Link href="/runs/new">
              <Play className="h-4 w-4" /> New run
            </Link>
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {isPending ? (
          <>
            <StatCardSkeleton />
            <StatCardSkeleton />
            <StatCardSkeleton />
          </>
        ) : (
          <>
            <StatCard label="Active runs" value={active.length} hint="Queued or running" icon={Activity} />
            <StatCard label="Completed" value={done.length} hint={`of ${runs.length} recent runs`} icon={CheckCircle2} />
            <StatCard
              label="Last run"
              value={runs[0] ? formatRelative(runs[0].requestedAt) : "—"}
              hint={runs[0]?.target ?? "No runs yet"}
              icon={Clock}
            />
          </>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent runs</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isPending ? (
            <div className="space-y-2 p-6">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : error ? (
            <div className="p-6">
              <EmptyState variant="error" title="Could not load runs" description={(error as Error).message} />
            </div>
          ) : runs.length === 0 ? (
            <div className="p-6">
              <EmptyState
                title="No benchmark runs yet"
                description="Start a run against one of the registered targets."
                action={
                  <Button asChild size="sm">
                    <Link href="/runs/new">New run</Link>
                  </Button>
                }
              />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Run</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Tests</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Requested</TableHead>
                  <TableHead numeric>Duration</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((r) => (
                  <TableRow key={r.runId}>
                    <TableCell className="font-mono text-xs">
                      <Link href={`/runs/${r.runId}`} className="text-primary hover:underline">
                        {r.runId}
                      </Link>
                      {r.note && <div className="max-w-[16rem] truncate font-sans text-muted-foreground">{r.note}</div>}
                    </TableCell>
                    <TableCell>{r.target}</TableCell>
                    <TableCell className="max-w-[18rem] truncate text-muted-foreground">
                      {r.tests.map((t) => TEST_INFO[t]?.title ?? t).join(", ")}
                    </TableCell>
                    <TableCell>
                      <RunStatusBadge status={r.status} />
                      {r.currentStep && <div className="mt-1 text-xs text-muted-foreground">step: {r.currentStep}</div>}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(r.requestedAt)}</TableCell>
                    <TableCell numeric>{formatDuration(runDurationMs(r))}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </main>
  )
}
