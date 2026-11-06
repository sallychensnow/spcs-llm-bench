"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useQuery } from "@tanstack/react-query"
import { AlertTriangle, Loader2, Play } from "lucide-react"
import { DEFAULT_SLA, DISRUPTIVE_TESTS, LEVELS_RE, TEST_INFO, TESTS, type Target, type TestName } from "@/lib/bench-shared"
import { PageHeader } from "@/components/page-header"
import { EmptyState } from "@/components/empty-state"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

const inputCls =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
    </label>
  )
}

/** Rough runtime estimate from the dry run on GPU_NV_M (minutes per step at the default levels). */
function estimateMinutes(tests: TestName[], levels: number[]): number {
  const scale = Math.max(1, levels.length / 6)
  const per: Record<TestName, number> = { baseline: 35, ramp: 25 * scale, shape: 85 * scale, coldstart: 15, replica: 50 * scale + 20 }
  return Math.round(tests.reduce((s, t) => s + per[t], 0))
}

export function NewRunForm() {
  const router = useRouter()
  const { data, error, isPending } = useQuery({
    queryKey: ["targets"],
    queryFn: async () => {
      const r = await fetch("/api/targets")
      const b = await r.json()
      if (!r.ok) throw new Error(b.error ?? "Failed")
      return b as { targets: Target[] }
    },
  })
  const targets = data?.targets ?? []

  const [targetName, setTargetName] = useState("")
  const [tests, setTests] = useState<TestName[]>(["baseline", "ramp", "shape"])
  const [levels, setLevels] = useState("1 2 4 8 16 32")
  const [minPrompts, setMinPrompts] = useState(8)
  const [sla, setSla] = useState(DEFAULT_SLA)
  const [note, setNote] = useState("")
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [confirmText, setConfirmText] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  useEffect(() => {
    if (!targetName && targets.length > 0) setTargetName(targets[0].name)
  }, [targets, targetName])

  const target = targets.find((t) => t.name === targetName)
  const disruptiveSelected = tests.some((t) => DISRUPTIVE_TESTS.includes(t))
  const levelsValid = LEVELS_RE.test(levels.trim().replace(/\s+/g, " "))
  const levelNums = useMemo(() => (levelsValid ? levels.trim().split(/\s+/).map(Number) : []), [levels, levelsValid])
  const canSubmit = !!target && tests.length > 0 && levelsValid && !submitting && (!disruptiveSelected || target.allowDisruptive)

  const toggle = (t: TestName) => setTests((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]))

  async function submit(withConfirm: string | undefined) {
    setSubmitting(true)
    setSubmitError(null)
    try {
      const r = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: targetName, tests, levels, minPrompts, sla, note, confirmText: withConfirm }),
      })
      const b = await r.json()
      if (!r.ok) throw new Error(b.error ?? "Failed to start run")
      router.push(`/runs/${b.runId}`)
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e))
      setSubmitting(false)
      setConfirmOpen(false)
    }
  }

  const onStart = () => (disruptiveSelected ? (setConfirmText(""), setConfirmOpen(true)) : submit(undefined))

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <PageHeader
        eyebrow="New run"
        title="Configure a benchmark run"
        description="The run is queued and executed by the BENCH_RUNNER task as SPCS jobs. You can close this page; progress is saved."
      />

      {isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : error ? (
        <EmptyState variant="error" title="Could not load targets" description={(error as Error).message} />
      ) : targets.length === 0 ? (
        <EmptyState
          title="No targets registered"
          description="An administrator must register a PoC service in BENCH_TARGETS before runs can be started."
        />
      ) : (
        <div className="grid min-w-0 gap-6 lg:grid-cols-3">
          <div className="min-w-0 space-y-6 lg:col-span-2">
            <Card>
              <CardHeader>
                <CardTitle>1. Target</CardTitle>
                <CardDescription>Only PoC services registered by an administrator are listed.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <select className={inputCls} value={targetName} onChange={(e) => setTargetName(e.target.value)}>
                  {targets.map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.name} — {t.model}
                    </option>
                  ))}
                </select>
                {target && (
                  <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                    <dt className="text-muted-foreground">Service</dt>
                    <dd className="truncate font-mono text-xs">{target.serviceFqn}</dd>
                    <dt className="text-muted-foreground">Endpoint</dt>
                    <dd className="truncate font-mono text-xs">{target.baseUrl}</dd>
                    <dt className="text-muted-foreground">Disruptive tests</dt>
                    <dd>{target.allowDisruptive ? <Badge variant="warning">allowed</Badge> : <Badge variant="outline">not allowed</Badge>}</dd>
                    {target.description && (
                      <>
                        <dt className="text-muted-foreground">Notes</dt>
                        <dd className="text-muted-foreground">{target.description}</dd>
                      </>
                    )}
                  </dl>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>2. Tests</CardTitle>
                <CardDescription>Steps run in this order. Disruptive steps suspend/resume or rescale the target.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {TESTS.map((t) => {
                  const disruptive = DISRUPTIVE_TESTS.includes(t)
                  const disabled = disruptive && !target?.allowDisruptive
                  return (
                    <label
                      key={t}
                      className={cn(
                        "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/50",
                        tests.includes(t) && "border-primary/50 bg-primary/5",
                        disabled && "cursor-not-allowed opacity-50",
                      )}
                    >
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 accent-[var(--brand-primary)]"
                        checked={tests.includes(t)}
                        disabled={disabled}
                        onChange={() => toggle(t)}
                      />
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                          {TEST_INFO[t].title}
                          {disruptive && <Badge variant="warning">disruptive</Badge>}
                        </span>
                        <span className="block text-xs text-muted-foreground">{TEST_INFO[t].detail}</span>
                      </span>
                    </label>
                  )
                })}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>3. Load & SLA</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <Field label="Concurrency levels" hint="Space-separated, up to 12 values, 1–256">
                  <input className={cn(inputCls, !levelsValid && "border-destructive")} value={levels} onChange={(e) => setLevels(e.target.value)} />
                </Field>
                <Field label="Min prompts per level" hint="Each level sends max(this, 4 × concurrency) requests">
                  <input type="number" min={1} max={200} className={inputCls} value={minPrompts} onChange={(e) => setMinPrompts(Number(e.target.value))} />
                </Field>
                <Field label="TTFT p95 < (s)">
                  <input type="number" step="0.1" min={0.1} className={inputCls} value={sla.ttft_p95_s} onChange={(e) => setSla({ ...sla, ttft_p95_s: Number(e.target.value) })} />
                </Field>
                <Field label="End-to-end p95 < (s)">
                  <input type="number" step="1" min={1} className={inputCls} value={sla.e2e_p95_s} onChange={(e) => setSla({ ...sla, e2e_p95_s: Number(e.target.value) })} />
                </Field>
                <Field label="Output tok/s per request ≥" hint="Checked on the slowest 5% of requests (1000 / TPOT p95)">
                  <input type="number" step="1" min={1} className={inputCls} value={sla.min_tok_s} onChange={(e) => setSla({ ...sla, min_tok_s: Number(e.target.value) })} />
                </Field>
                <Field label="Note">
                  <input className={inputCls} maxLength={500} value={note} placeholder="e.g. prod flags, eager off" onChange={(e) => setNote(e.target.value)} />
                </Field>
              </CardContent>
            </Card>
          </div>

          <div className="min-w-0 space-y-4">
            <Card className="lg:sticky lg:top-20">
              <CardHeader>
                <CardTitle>Summary</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Target</span>
                  <span className="truncate font-medium">{targetName}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Tests</span>
                  <span>{tests.length}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Levels</span>
                  <span>{levelsValid ? levelNums.join(", ") : "invalid"}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Est. runtime</span>
                  <span>≈ {Math.round(estimateMinutes(tests, levelNums) / 6) / 10} h</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Estimate from the GPU_NV_M dry run (~12 tok/s per request); faster services finish sooner. A suspended target adds ~15 min to start.
                </p>
                {disruptiveSelected && (
                  <Alert variant="warning">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle>Disruptive tests selected</AlertTitle>
                    <AlertDescription>The target will be suspended/resumed or rescaled. Clients using it will see errors during those steps.</AlertDescription>
                  </Alert>
                )}
                {submitError && (
                  <Alert variant="destructive">
                    <AlertTitle>Could not start</AlertTitle>
                    <AlertDescription>{submitError}</AlertDescription>
                  </Alert>
                )}
                <Button className="w-full" disabled={!canSubmit} onClick={onStart}>
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                  Start run
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      <Dialog open={confirmOpen} onOpenChange={(o) => !submitting && setConfirmOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm disruptive tests</DialogTitle>
            <DialogDescription>
              {tests.includes("coldstart") && "Cold start will SUSPEND and RESUME the service (≈15 min unavailable). "}
              {tests.includes("replica") && "Replica scaling will change MIN/MAX_INSTANCES to 2 and restore them afterwards. "}
              Type the target name <span className="font-mono font-semibold text-foreground">{targetName}</span> to confirm.
            </DialogDescription>
          </DialogHeader>
          <input className={inputCls} autoFocus value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={targetName} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={confirmText !== targetName || submitting} onClick={() => submit(confirmText)}>
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Confirm and start
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}
