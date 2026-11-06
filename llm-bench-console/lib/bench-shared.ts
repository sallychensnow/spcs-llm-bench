/** Types and constants shared by server code and client components (no server imports here). */

export const TESTS = ["baseline", "ramp", "shape", "coldstart", "replica"] as const
export type TestName = (typeof TESTS)[number]
export const DISRUPTIVE_TESTS: TestName[] = ["coldstart", "replica"]

export const TEST_INFO: Record<TestName, { title: string; detail: string }> = {
  baseline: { title: "Baseline", detail: "Concurrency 1 · short 256/256, medium 2048/512, long 8192/512" },
  ramp: { title: "Concurrency ramp", detail: "1024 in / 512 out at each concurrency level" },
  shape: { title: "Token shape", detail: "RAG 6144/256 vs chat 256/1536 at each level" },
  coldstart: { title: "Cold start", detail: "SUSPEND → RESUME the target, time to first response" },
  replica: { title: "Replica scaling", detail: "Ramp at 1 vs 2 replicas (changes MIN/MAX_INSTANCES)" },
}

export type Sla = { ttft_p95_s: number; e2e_p95_s: number; min_tok_s: number }
export const DEFAULT_SLA: Sla = { ttft_p95_s: 2, e2e_p95_s: 30, min_tok_s: 15 }

export const RUN_ID_RE = /^[A-Za-z0-9_]{1,40}$/
export const LEVELS_RE = /^[0-9]{1,3}( [0-9]{1,3}){0,11}$/

export const ACTIVE_STATUSES = ["QUEUED", "RUNNING", "CANCEL_REQUESTED"]

export type Target = {
  name: string
  serviceFqn: string
  baseUrl: string
  model: string
  clientPool: string
  allowDisruptive: boolean
  description: string | null
}

export type Run = {
  runId: string
  target: string
  tests: TestName[]
  levels: string
  minPrompts: number
  sla: Sla
  confirmDisruptive: boolean
  status: string
  currentStep: string | null
  currentJob: string | null
  note: string | null
  requestedBy: string | null
  requestedAt: string | null
  startedAt: string | null
  finishedAt: string | null
  error: string | null
}

export type LogEvent = { test: string; replicas: number; event: string; ts: string | null; detail: any }

export type ResultPoint = {
  test: string
  label: string
  inputLen: number | null
  outputLen: number | null
  concurrency: number
  numPrompts: number
  completed: number
  failed: number
  durationS: number | null
  reqPerS: number | null
  outTokPerS: number | null
  ttftP50: number | null
  ttftP95: number | null
  ttftP99: number | null
  tpotP50: number | null
  tpotP95: number | null
  tokPerReqP95: number | null
  e2eP50: number | null
  e2eP95: number | null
  meetsSla: boolean
  failedChecks: string[]
}

export function evaluateSla(p: Omit<ResultPoint, "meetsSla" | "failedChecks">, sla: Sla) {
  const failed: string[] = []
  if (p.ttftP95 === null || p.ttftP95 >= sla.ttft_p95_s) failed.push("TTFT")
  if (p.e2eP95 === null || p.e2eP95 >= sla.e2e_p95_s) failed.push("E2E")
  if (p.tokPerReqP95 === null || p.tokPerReqP95 < sla.min_tok_s) failed.push("tok/s")
  if (p.failed > 0) failed.push("errors")
  return { meetsSla: failed.length === 0, failedChecks: failed }
}

export type ColdStart = { mode: string; modelsReadyS: number | null; firstResponseS: number | null; resumeToProbeS: number | null }


/** Display name for a curve (test + label) used in reports and comparison charts. */
export function shapeName(p: Pick<ResultPoint, "test" | "label" | "inputLen" | "outputLen">): string {
  if (p.test === "shape" && p.label === "rag") return `RAG ${p.inputLen}/${p.outputLen}`
  if (p.test === "shape" && p.label === "chat") return `Chat ${p.inputLen}/${p.outputLen}`
  if (p.test === "replica") return `${p.label.replace("replica_", "")} replica(s) ${p.inputLen}/${p.outputLen}`
  return `Ramp ${p.inputLen}/${p.outputLen}`
}

export type Finding = { level: "good" | "warn" | "bad" | "info"; en: string }

const r1 = (v: number) => Math.round(v * 10) / 10

/**
 * Rule-based conclusions from the measured points. Kept deliberately conservative: each finding
 * states a measured fact and, where the data supports it, the likely cause.
 */
export function buildFindings(results: ResultPoint[], coldStart: ColdStart[], sla: Sla): Finding[] {
  const out: Finding[] = []
  const curves = results.filter((r) => ["ramp", "shape", "replica"].includes(r.test))
  const baseline = results.filter((r) => r.test === "baseline")
  const all = [...baseline, ...curves]
  if (all.length === 0) return out

  const failed = all.reduce((s, p) => s + p.failed, 0)
  const total = all.reduce((s, p) => s + p.numPrompts, 0)
  out.push(
    failed === 0
      ? { level: "good", en: `All ${total} requests completed with no errors.` }
      : { level: "bad", en: `${failed} of ${total} requests failed; check the service logs.` },
  )

  // Capacity per curve
  const groups = new Map<string, ResultPoint[]>()
  for (const p of curves) {
    const k = shapeName(p)
    groups.set(k, [...(groups.get(k) ?? []), p])
  }
  for (const [name, pts] of groups) {
    const sorted = [...pts].sort((a, b) => a.concurrency - b.concurrency)
    const ok = sorted.filter((p) => p.meetsSla)
    const firstTtftFail = sorted.find((p) => p.failedChecks.includes("TTFT"))
    if (ok.length > 0) {
      const best = ok[ok.length - 1]
      out.push({
        level: "good",
        en: `${name}: max SLA concurrency ${best.concurrency} (${r1(best.reqPerS ?? 0)} req/s, ${Math.round(best.outTokPerS ?? 0)} output tok/s).`,
      })
    } else {
      const reasons = Array.from(new Set(sorted.flatMap((p) => p.failedChecks)))
      out.push({
        level: "bad",
        en: `${name}: no concurrency level meets the SLA (failing: ${reasons.join(", ")}).`,
      })
    }
    if (firstTtftFail) {
      out.push({
        level: "warn",
        en: `${name}: TTFT p95 reaches ${r1(firstTtftFail.ttftP95 ?? 0)}s at concurrency ${firstTtftFail.concurrency} (target < ${sla.ttft_p95_s}s).`,
      })
    }
  }

  // Decode speed: fixed per-step overhead vs. GPU saturation
  const single = all.filter((p) => p.concurrency === 1 && p.tokPerReqP95 !== null)
  if (single.length > 0) {
    const s = single.reduce((a, p) => a + (p.tokPerReqP95 ?? 0), 0) / single.length
    if (s < sla.min_tok_s) {
      out.push({
        level: "bad",
        en: `Single-request decode speed is only ${r1(s)} tok/s, below the ${sla.min_tok_s} tok/s target, so no concurrency can meet it; server-side decode speed must improve first.`,
      })
    }
  }
  const ramp = (groups.get([...groups.keys()].find((k) => k.startsWith("Ramp")) ?? "") ?? []).sort((a, b) => a.concurrency - b.concurrency)
  if (ramp.length >= 3) {
    const lo = ramp[0]
    const hi = ramp[ramp.length - 1]
    const tputGain = (hi.outTokPerS ?? 0) / Math.max(lo.outTokPerS ?? 1, 1e-6)
    const concGain = hi.concurrency / lo.concurrency
    const perReqDrop = 1 - (hi.tokPerReqP95 ?? 0) / Math.max(lo.tokPerReqP95 ?? 1, 1e-6)
    if (tputGain > 0.6 * concGain && perReqDrop < 0.3) {
      out.push({
        level: "info",
        en: `From concurrency ${lo.concurrency} to ${hi.concurrency}, throughput grew ${r1(tputGain)}x while per-request speed fell only ${Math.round(perReqDrop * 100)}%: the GPU is far from saturated and per-step overhead dominates (typical causes: --enforce-eager disabling CUDA Graphs, PCIe all-reduce across GPUs).`,
      })
    } else if (perReqDrop >= 0.3) {
      out.push({
        level: "info",
        en: `At concurrency ${hi.concurrency} per-request speed dropped ${Math.round(perReqDrop * 100)}%: the service is near saturation.`,
      })
    }
  }

  // RAG vs chat
  const rag = curves.filter((p) => p.test === "shape" && p.label === "rag")
  const chat = curves.filter((p) => p.test === "shape" && p.label === "chat")
  if (rag.length && chat.length) {
    const c = Math.max(...rag.map((p) => p.concurrency).filter((x) => chat.some((q) => q.concurrency === x)))
    const a = rag.find((p) => p.concurrency === c)
    const b = chat.find((p) => p.concurrency === c)
    if (a?.ttftP95 != null && b?.ttftP95 != null && b.ttftP95 > 0) {
      out.push({
        level: "info",
        en: `At concurrency ${c}, RAG TTFT is ${r1(a.ttftP95 / b.ttftP95)}x chat: long-prompt prefill is the main bottleneck for RAG traffic; enable prefix caching and bound retrieved context length.`,
      })
    }
    const chatE2e = chat.find((p) => p.concurrency === Math.min(...chat.map((q) => q.concurrency)))
    if (chatE2e?.e2eP95 != null && chatE2e.e2eP95 >= sla.e2e_p95_s) {
      out.push({
        level: "warn",
        en: `Chat (long output) takes ${Math.round(chatE2e.e2eP95)}s end-to-end p95 even at concurrency 1 (target ${sla.e2e_p95_s}s); reasoning models make this worse. Stream responses and cap max_tokens.`,
      })
    }
  }

  // Replica scaling
  const rep1 = curves.filter((p) => p.label === "replica_1")
  const rep2 = curves.filter((p) => p.label === "replica_2")
  if (rep1.length && rep2.length) {
    const c = Math.max(...rep1.map((p) => p.concurrency).filter((x) => rep2.some((q) => q.concurrency === x)))
    const f = (rep2.find((p) => p.concurrency === c)?.outTokPerS ?? 0) / Math.max(rep1.find((p) => p.concurrency === c)?.outTokPerS ?? 1, 1e-6)
    out.push({
      level: f >= 1.7 ? "good" : "warn",
      en: `At concurrency ${c}, 2 replicas deliver ${r1(f)}x the throughput of 1 (ideal 2.0).`,
    })
  }

  // Cold start
  const restart = coldStart.find((c) => c.mode === "restart")
  if (restart?.firstResponseS != null) {
    const mins = (restart.firstResponseS + (restart.resumeToProbeS ?? 0)) / 60
    out.push({
      level: mins > 5 ? "warn" : "good",
      en: `Cold start (suspend → resume → first response) took ${r1(mins)} min${mins > 5 ? "; too slow for on-demand scaling, so keep a warm replica or speed up weight loading (storage throughput, weights in image/local disk)" : ""}.`,
    })
  }
  return out
}
