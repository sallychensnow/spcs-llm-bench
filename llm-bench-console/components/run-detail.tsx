"use client"

import Link from "next/link"
import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CheckCircle2, CircleDashed, Download, Gauge, Loader2, MinusCircle, Play, Snowflake, Square, Timer, XCircle, Zap } from "lucide-react"
import {
  ACTIVE_STATUSES,
  TEST_INFO,
  TESTS,
  type ColdStart,
  type LogEvent,
  type ResultPoint,
  type Run,
  type TestName,
} from "@/lib/bench-shared"
import { formatDateTime, formatDuration, formatNumber } from "@/lib/format"
import { PageHeader } from "@/components/page-header"
import { StatCard, StatCardSkeleton } from "@/components/stat-card"
import { EmptyState } from "@/components/empty-state"
import { RunStatusBadge } from "@/components/run-status-badge"
import { MetricChart, type Series } from "@/components/metric-chart"
import { RunReport } from "@/components/run-report"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"

type Detail = { run: Run; log: LogEvent[]; results: ResultPoint[]; coldStart: ColdStart[] }

type StepState = "pending" | "running" | "done" | "failed" | "skipped"

function stepStates(run: Run, log: LogEvent[]): { step: string; state: StepState; startedAt?: string | null; endedAt?: string | null; info?: string }[] {
  const steps = ["warmup", ...TESTS.filter((t) => run.tests.includes(t))]
  return steps.map((step) => {
    const ev = log.filter((e) => e.test === step)
    const start = ev.find((e) => e.event === "step_start")
    const end = ev.find((e) => ["step_done", "step_failed", "step_skipped"].includes(e.event))
    let state: StepState = "pending"
    if (end?.event === "step_done") state = "done"
    else if (end?.event === "step_failed") state = "failed"
    else if (end?.event === "step_skipped") state = "skipped"
    else if (start) state = ACTIVE_STATUSES.includes(run.status) ? "running" : "failed"
    const info = end?.detail?.error ?? end?.detail?.reason ?? (step === "warmup" && end?.detail?.seconds !== undefined ? `service READY after ${formatDuration(end.detail.seconds * 1000)}` : undefined)
    return { step, state, startedAt: start?.ts, endedAt: end?.ts, info }
  })
}

const STEP_ICON: Record<StepState, React.ReactNode> = {
  pending: <CircleDashed className="h-4 w-4 text-muted-foreground" />,
  running: <Loader2 className="h-4 w-4 animate-spin text-primary" />,
  done: <CheckCircle2 className="h-4 w-4 text-success" />,
  failed: <XCircle className="h-4 w-4 text-destructive" />,
  skipped: <MinusCircle className="h-4 w-4 text-warning" />,
}

function seriesFor(results: ResultPoint[], test: string, labelName: (l: string) => string): Series[] {
  const pts = results.filter((r) => r.test === test)
  const labels = Array.from(new Set(pts.map((p) => p.label)))
  return labels.map((l) => ({ key: l, name: labelName(l), points: pts.filter((p) => p.label === l) }))
}

function fmt(v: number | null, digits = 2) {
  return v === null ? "—" : formatNumber(v, digits)
}

function SlaCell({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return <TableCell numeric className={cn(!ok && "font-medium text-destructive")}>{children}</TableCell>
}

function ResultsTable({ points, run }: { points: ResultPoint[]; run: Run }) {
  return (
    <Table striped>
      <TableHeader>
        <TableRow>
          <TableHead>Shape</TableHead>
          <TableHead numeric>In/Out</TableHead>
          <TableHead numeric>Conc.</TableHead>
          <TableHead numeric>OK/Fail</TableHead>
          <TableHead numeric>TTFT p50</TableHead>
          <TableHead numeric>TTFT p95</TableHead>
          <TableHead numeric>TPOT p95</TableHead>
          <TableHead numeric>tok/s/req</TableHead>
          <TableHead numeric>E2E p95</TableHead>
          <TableHead numeric>Req/s</TableHead>
          <TableHead numeric>Out tok/s</TableHead>
          <TableHead>SLA</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {points.map((p) => (
          <TableRow key={`${p.test}-${p.label}-${p.inputLen}-${p.concurrency}`}>
            <TableCell>{p.label}</TableCell>
            <TableCell numeric className="whitespace-nowrap text-muted-foreground">
              {p.inputLen}/{p.outputLen}
            </TableCell>
            <TableCell numeric>{p.concurrency}</TableCell>
            <TableCell numeric className={cn(p.failed > 0 && "text-destructive")}>
              {p.completed}/{p.failed}
            </TableCell>
            <TableCell numeric>{fmt(p.ttftP50)} s</TableCell>
            <SlaCell ok={!p.failedChecks.includes("TTFT")}>{fmt(p.ttftP95)} s</SlaCell>
            <TableCell numeric>{fmt(p.tpotP95, 1)} ms</TableCell>
            <SlaCell ok={!p.failedChecks.includes("tok/s")}>{fmt(p.tokPerReqP95, 1)}</SlaCell>
            <SlaCell ok={!p.failedChecks.includes("E2E")}>{fmt(p.e2eP95, 1)} s</SlaCell>
            <TableCell numeric>{fmt(p.reqPerS, 3)}</TableCell>
            <TableCell numeric>{fmt(p.outTokPerS, 1)}</TableCell>
            <TableCell>
              {p.meetsSla ? <Badge variant="success">pass</Badge> : <Badge variant="destructive">{p.failedChecks.join(", ")}</Badge>}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function CurveCard({ title, description, series, run }: { title: string; description: string; series: Series[]; run: Run }) {
  if (series.length === 0) return null
  const points = series.flatMap((s) => s.points)
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid min-w-0 gap-6 lg:grid-cols-3">
          <div className="min-w-0">
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">TTFT p95 (s)</p>
            <MetricChart series={series} metric={(p) => p.ttftP95} unit="s" sla={run.sla.ttft_p95_s} slaLabel={`SLA ${run.sla.ttft_p95_s}s`} />
          </div>
          <div className="min-w-0">
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Output tok/s per request (p95)</p>
            <MetricChart series={series} metric={(p) => p.tokPerReqP95} unit="" sla={run.sla.min_tok_s} slaLabel={`SLA ≥ ${run.sla.min_tok_s}`} />
          </div>
          <div className="min-w-0">
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Total output tok/s</p>
            <MetricChart series={series} metric={(p) => p.outTokPerS} unit="" />
          </div>
        </div>
        <div className="-mx-6 border-t">
          <ResultsTable points={points} run={run} />
        </div>
      </CardContent>
    </Card>
  )
}

function usePost(url: string, runId: string, setActionError: (e: string | null) => void) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const r = await fetch(url, { method: "POST" })
      const b = await r.json()
      if (!r.ok) throw new Error(b.error ?? "Failed")
      if (b.started === false && b.message) throw new Error(b.message)
      return b
    },
    onSuccess: () => {
      setActionError(null)
      qc.invalidateQueries({ queryKey: ["run", runId] })
    },
    onError: (e) => setActionError(e instanceof Error ? e.message : String(e)),
  })
}

export function RunDetail({ runId }: { runId: string }) {
  const [actionError, setActionError] = useState<string | null>(null)
  const { data, error, isPending } = useQuery({
    queryKey: ["run", runId],
    queryFn: async () => {
      const r = await fetch(`/api/runs/${encodeURIComponent(runId)}`)
      const b = await r.json()
      if (!r.ok) throw new Error(b.error ?? "Failed")
      return b as Detail
    },
    refetchInterval: (q) => (q.state.data && ACTIVE_STATUSES.includes(q.state.data.run.status) ? 15000 : false),
  })

  const cancel = usePost(`/api/runs/${encodeURIComponent(runId)}/cancel`, runId, setActionError)
  const kick = usePost(`/api/runner`, runId, setActionError)

  if (isPending) {
    return (
      <main className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
        <Skeleton className="h-16 w-1/2" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <StatCardSkeleton key={i} />
          ))}
        </div>
        <Skeleton className="h-80 w-full" />
      </main>
    )
  }
  if (error || !data) {
    return (
      <main className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        <EmptyState variant="error" title="Could not load run" description={(error as Error)?.message} />
      </main>
    )
  }

  const { run, log, results, coldStart } = data
  const steps = stepStates(run, log)
  const active = ACTIVE_STATUSES.includes(run.status)
  const curvePoints = results.filter((r) => ["ramp", "shape", "replica"].includes(r.test))
  const passing = curvePoints.filter((p) => p.meetsSla)
  const maxSlaConc = passing.length ? Math.max(...passing.map((p) => p.concurrency)) : 0
  const peakTok = curvePoints.reduce((m, p) => Math.max(m, p.outTokPerS ?? 0), 0)
  const baseline = results.filter((r) => r.test === "baseline")
  const singleTok = baseline.length ? baseline.reduce((s, p) => s + (p.tokPerReqP95 ?? 0), 0) / baseline.length : null
  const totalReq = results.reduce((s, p) => s + p.numPrompts, 0)
  const totalFail = results.reduce((s, p) => s + p.failed, 0)
  const restart = coldStart.find((c) => c.mode === "restart")
  const scaleup = coldStart.find((c) => c.mode === "scaleup")
  const elapsedMs = run.startedAt ? (run.finishedAt ? new Date(run.finishedAt) : new Date()).getTime() - new Date(run.startedAt).getTime() : null

  const shapeName = (l: string) => (l === "rag" ? "RAG 6144/256" : l === "chat" ? "Chat 256/1536" : l)
  const replicaName = (l: string) => l.replace("replica_", "") + " replica(s)"

  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <PageHeader
        eyebrow={
          <Link href="/" className="hover:underline">
            ← Runs
          </Link>
        }
        title={<span className="font-mono text-xl sm:text-2xl">{run.runId}</span>}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <RunStatusBadge status={run.status} />
            <span>
              {run.target} · requested {formatDateTime(run.requestedAt)}
              {run.requestedBy ? ` by ${run.requestedBy}` : ""}
            </span>
          </span>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {run.status === "QUEUED" && (
              <Button variant="outline" onClick={() => kick.mutate()} disabled={kick.isPending}>
                {kick.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Start runner
              </Button>
            )}
            {(run.status === "QUEUED" || run.status === "RUNNING") && (
              <Button variant="outline" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                {cancel.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />} Cancel
              </Button>
            )}
            <Button variant="outline" asChild disabled={results.length === 0}>
              <a href={`/api/runs/${encodeURIComponent(run.runId)}/csv`}>
                <Download className="h-4 w-4" /> CSV
              </a>
            </Button>
          </div>
        }
      />

      {actionError && (
        <Alert variant="destructive">
          <AlertTitle>Action failed</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}
      {run.error && (
        <Alert variant="destructive">
          <AlertTitle>Run error</AlertTitle>
          <AlertDescription className="break-words">{run.error}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Max SLA concurrency"
          value={curvePoints.length ? maxSlaConc : "—"}
          hint={`TTFT<${run.sla.ttft_p95_s}s · E2E<${run.sla.e2e_p95_s}s · ≥${run.sla.min_tok_s} tok/s`}
          icon={Gauge}
          className={cn(curvePoints.length > 0 && maxSlaConc === 0 && "border-destructive/50")}
        />
        <StatCard label="Single-request speed" value={singleTok === null ? "—" : `${formatNumber(singleTok, 1)} tok/s`} hint="Baseline, p95 TPOT" icon={Zap} />
        <StatCard label="Peak throughput" value={peakTok ? `${formatNumber(peakTok, 0)} tok/s` : "—"} hint="Total output tokens / s" icon={Timer} />
        <StatCard
          label="Cold start"
          value={restart?.firstResponseS != null ? formatDuration(((restart.firstResponseS ?? 0) + (restart.resumeToProbeS ?? 0)) * 1000) : "—"}
          hint={scaleup?.firstResponseS != null ? `Scale-up 2nd replica: ${formatDuration(scaleup.firstResponseS * 1000)}` : "RESUME → first response"}
          icon={Snowflake}
        />
      </div>

      <RunReport run={run} results={results} coldStart={coldStart} />

      <Card>
        <CardHeader>
          <CardTitle>Progress</CardTitle>
          <CardDescription>
            {elapsedMs !== null ? `Elapsed ${formatDuration(elapsedMs)}` : "Waiting for the runner"} · {totalReq} requests · {totalFail} failed
            {active && " · refreshes every 15 s"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="space-y-3">
            {steps.map((s) => (
              <li key={s.step} className="flex items-start gap-3">
                <span className="mt-0.5">{STEP_ICON[s.state]}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                    <span className="text-sm font-medium">
                      {s.step === "warmup" ? "Start target service" : TEST_INFO[s.step as TestName].title}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {s.startedAt && s.endedAt
                        ? formatDuration(new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime())
                        : s.state === "running" && s.startedAt
                          ? `running ${formatDuration(Date.now() - new Date(s.startedAt).getTime())}`
                          : ""}
                    </span>
                  </div>
                  {s.state === "running" && run.currentJob && <p className="text-xs text-muted-foreground">job {run.currentJob}</p>}
                  {s.info && <p className={cn("break-words text-xs", s.state === "failed" ? "text-destructive" : "text-muted-foreground")}>{s.info}</p>}
                </div>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      {results.length === 0 && coldStart.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <EmptyState title="No results yet" description={active ? "Results appear after each step finishes." : "This run produced no results."} />
          </CardContent>
        </Card>
      ) : (
        <>
          {baseline.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Baseline</CardTitle>
                <CardDescription>Concurrency 1, prompt length effect on TTFT and end-to-end latency.</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <ResultsTable points={baseline} run={run} />
              </CardContent>
            </Card>
          )}
          <CurveCard
            title="Concurrency ramp"
            description="1024 in / 512 out. Find the highest concurrency that still meets every SLA."
            series={seriesFor(results, "ramp", () => "ramp 1024/512")}
            run={run}
          />
          <CurveCard
            title="Token shape"
            description="RAG (long prompt, prefill-bound) vs chat (long answer, decode-bound)."
            series={seriesFor(results, "shape", shapeName)}
            run={run}
          />
          <CurveCard
            title="Replica scaling"
            description="Same ramp at 1 and 2 replicas. Ideal scaling doubles total throughput."
            series={seriesFor(results, "replica", replicaName)}
            run={run}
          />
          {coldStart.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Cold start</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Mode</TableHead>
                      <TableHead numeric>RESUME → probe</TableHead>
                      <TableHead numeric>/v1/models ready</TableHead>
                      <TableHead numeric>First response</TableHead>
                      <TableHead numeric>Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {coldStart.map((c, i) => (
                      <TableRow key={i}>
                        <TableCell>{c.mode === "restart" ? "Restart (suspend → resume)" : "Scale-up (2nd replica READY)"}</TableCell>
                        <TableCell numeric>{c.resumeToProbeS == null ? "—" : formatDuration(c.resumeToProbeS * 1000)}</TableCell>
                        <TableCell numeric>{c.modelsReadyS == null ? "—" : formatDuration(c.modelsReadyS * 1000)}</TableCell>
                        <TableCell numeric>{c.firstResponseS == null ? "—" : formatDuration(c.firstResponseS * 1000)}</TableCell>
                        <TableCell numeric className="font-medium">
                          {c.firstResponseS == null ? "—" : formatDuration((c.firstResponseS + (c.resumeToProbeS ?? 0)) * 1000)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Configuration</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[10rem_1fr]">
          <span className="text-muted-foreground">Tests</span>
          <span>{run.tests.map((t) => TEST_INFO[t]?.title ?? t).join(", ")}</span>
          <span className="text-muted-foreground">Concurrency levels</span>
          <span className="font-mono">{run.levels}</span>
          <span className="text-muted-foreground">Min prompts / level</span>
          <span>{run.minPrompts}</span>
          <span className="text-muted-foreground">Disruptive confirmed</span>
          <span>{run.confirmDisruptive ? "yes" : "no"}</span>
          {run.note && (
            <>
              <span className="text-muted-foreground">Note</span>
              <span className="break-words">{run.note}</span>
            </>
          )}
        </CardContent>
      </Card>
    </main>
  )
}
