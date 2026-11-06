"use client"

import { AlertTriangle, CheckCircle2, Info, Printer, XCircle } from "lucide-react"
import { buildFindings, shapeName, type ColdStart, type Finding, type ResultPoint, type Run } from "@/lib/bench-shared"
import { formatDateTime } from "@/lib/format"
import { MetricChart, type Series } from "@/components/metric-chart"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

const ICON: Record<Finding["level"], React.ReactNode> = {
  good: <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />,
  warn: <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />,
  bad: <XCircle className="h-4 w-4 shrink-0 text-destructive" />,
  info: <Info className="h-4 w-4 shrink-0 text-primary" />,
}

const ORDER: Record<Finding["level"], number> = { bad: 0, warn: 1, info: 2, good: 3 }

/** All load-curve tests on one set of axes, so shapes can be compared directly. */
function comparisonSeries(results: ResultPoint[]): Series[] {
  const curves = results.filter((r) => ["ramp", "shape", "replica"].includes(r.test))
  const byName = new Map<string, ResultPoint[]>()
  for (const p of curves) {
    const k = shapeName(p)
    byName.set(k, [...(byName.get(k) ?? []), p])
  }
  return [...byName.entries()].map(([name, points]) => ({ key: name.replace(/[^A-Za-z0-9]/g, "_"), name, points }))
}

export function RunReport({ run, results, coldStart }: { run: Run; results: ResultPoint[]; coldStart: ColdStart[] }) {
  const findings = buildFindings(results, coldStart, run.sla).sort((a, b) => ORDER[a.level] - ORDER[b.level])
  const series = comparisonSeries(results)
  if (findings.length === 0 && series.length === 0) return null

  return (
    <Card className="report-card">
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle>Benchmark report</CardTitle>
          <CardDescription>
            {run.target} · {run.runId} · {formatDateTime(run.startedAt ?? run.requestedAt)} · SLA: TTFT p95 &lt; {run.sla.ttft_p95_s}s, E2E p95 &lt;{" "}
            {run.sla.e2e_p95_s}s, ≥ {run.sla.min_tok_s} tok/s per request
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" className="print:hidden" onClick={() => window.print()}>
          <Printer className="h-4 w-4" /> Print / PDF
        </Button>
      </CardHeader>
      <CardContent className="space-y-8">
        {findings.length > 0 && (
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Findings</h3>
            <ul className="space-y-3">
              {findings.map((f, i) => (
                <li key={i} className="flex gap-3 rounded-lg border p-3">
                  <span className="mt-0.5">{ICON[f.level]}</span>
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm">{f.en}</p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {series.length > 0 && (
          <section className="space-y-4">
            <h3 className="text-sm font-semibold">Shape comparison</h3>
            <div className="grid min-w-0 gap-6 lg:grid-cols-3">
              <div className="min-w-0 break-inside-avoid">
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">TTFT p95 (s)</p>
                <MetricChart series={series} metric={(p) => p.ttftP95} unit="s" sla={run.sla.ttft_p95_s} slaLabel={`SLA ${run.sla.ttft_p95_s}s`} />
              </div>
              <div className="min-w-0 break-inside-avoid">
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Per-request tok/s (p95)</p>
                <MetricChart series={series} metric={(p) => p.tokPerReqP95} unit="" sla={run.sla.min_tok_s} slaLabel={`SLA ≥ ${run.sla.min_tok_s}`} />
              </div>
              <div className="min-w-0 break-inside-avoid">
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Total output tok/s</p>
                <MetricChart series={series} metric={(p) => p.outTokPerS} unit="" />
              </div>
            </div>
            <div className="grid min-w-0 gap-6 lg:grid-cols-2">
              <div className="min-w-0 break-inside-avoid">
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">End-to-end p95 (s)</p>
                <MetricChart series={series} metric={(p) => p.e2eP95} unit="s" sla={run.sla.e2e_p95_s} slaLabel={`SLA ${run.sla.e2e_p95_s}s`} />
              </div>
              <div className="min-w-0 break-inside-avoid">
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Request throughput (req/s)</p>
                <MetricChart series={series} metric={(p) => p.reqPerS} unit="" />
              </div>
            </div>
          </section>
        )}
      </CardContent>
    </Card>
  )
}
