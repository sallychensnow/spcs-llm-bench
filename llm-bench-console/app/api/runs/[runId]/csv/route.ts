import { getResults, getRun, RUN_ID_RE } from "@/lib/bench"

export const dynamic = "force-dynamic"

const COLUMNS = [
  ["test", "test"],
  ["label", "label"],
  ["inputLen", "input_len"],
  ["outputLen", "output_len"],
  ["concurrency", "concurrency"],
  ["numPrompts", "num_prompts"],
  ["completed", "completed"],
  ["failed", "failed"],
  ["ttftP50", "ttft_p50_s"],
  ["ttftP95", "ttft_p95_s"],
  ["ttftP99", "ttft_p99_s"],
  ["tpotP50", "tpot_p50_ms"],
  ["tpotP95", "tpot_p95_ms"],
  ["tokPerReqP95", "tok_per_req_p95"],
  ["e2eP50", "e2e_p50_s"],
  ["e2eP95", "e2e_p95_s"],
  ["reqPerS", "req_per_s"],
  ["outTokPerS", "out_tok_per_s"],
  ["meetsSla", "meets_sla"],
  ["failedChecks", "failed_checks"],
] as const

function cell(v: unknown): string {
  if (v === null || v === undefined) return ""
  const s = Array.isArray(v) ? v.join("|") : String(v)
  // Quote, and neutralise spreadsheet formula injection.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s
  return `"${safe.replace(/"/g, '""')}"`
}

export async function GET(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params
  if (!RUN_ID_RE.test(runId)) return new Response("Invalid run id", { status: 400 })
  try {
    const run = await getRun(runId)
    if (!run) return new Response("Run not found", { status: 404 })
    const results = await getResults(runId, run.sla)
    const lines = [COLUMNS.map(([, h]) => h).join(",")]
    for (const r of results) lines.push(COLUMNS.map(([k]) => cell((r as any)[k])).join(","))
    return new Response("\uFEFF" + lines.join("\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="bench_${runId}.csv"`,
      },
    })
  } catch (e) {
    console.error(new Date().toISOString(), "[api/csv]", e)
    return new Response("Failed to export", { status: 500 })
  }
}
