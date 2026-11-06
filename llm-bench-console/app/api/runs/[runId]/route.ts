import { getColdStart, getResults, getRun, getRunLog, RUN_ID_RE } from "@/lib/bench"

export const dynamic = "force-dynamic"

export async function GET(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params
  if (!RUN_ID_RE.test(runId)) return Response.json({ error: "Invalid run id" }, { status: 400 })
  try {
    const run = await getRun(runId)
    if (!run) return Response.json({ error: "Run not found" }, { status: 404 })
    const [log, results, coldStart] = await Promise.all([getRunLog(runId), getResults(runId, run.sla), getColdStart(runId)])
    return Response.json({ run, log, results, coldStart })
  } catch (e) {
    console.error(new Date().toISOString(), "[api/runs/:id]", e)
    return Response.json({ error: e instanceof Error ? e.message : "Failed to load run" }, { status: 500 })
  }
}
