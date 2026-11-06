import { querySnowflake } from "@/lib/snowflake"
import { benchSchema, getRun, RUN_ID_RE } from "@/lib/bench"

export const dynamic = "force-dynamic"

/**
 * Cancel a run. Queued runs are cancelled immediately. For a running run the orchestrator
 * stops after the current step; dropping the current bench job makes that step end now.
 * The target service is left as it is (a cold-start step may leave it resuming).
 */
export async function POST(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params
  if (!RUN_ID_RE.test(runId)) return Response.json({ error: "Invalid run id" }, { status: 400 })
  try {
    const s = benchSchema()
    const run = await getRun(runId)
    if (!run) return Response.json({ error: "Run not found" }, { status: 404 })

    if (run.status === "QUEUED") {
      await querySnowflake(
        `UPDATE ${s}.BENCH_RUNS SET STATUS = 'CANCELLED', FINISHED_AT = CURRENT_TIMESTAMP() WHERE RUN_ID = ? AND STATUS = 'QUEUED'`,
        { binds: [runId] },
      )
      return Response.json({ status: "CANCELLED" })
    }
    if (run.status !== "RUNNING") return Response.json({ error: `Run is ${run.status}` }, { status: 409 })

    await querySnowflake(`UPDATE ${s}.BENCH_RUNS SET STATUS = 'CANCEL_REQUESTED' WHERE RUN_ID = ? AND STATUS = 'RUNNING'`, {
      binds: [runId],
    })
    // CURRENT_JOB is written by RUN_BENCH_JOB; only drop names that match its pattern.
    if (run.currentJob && /^BENCH_[A-Z0-9_]{1,80}$/.test(run.currentJob)) {
      try {
        await querySnowflake(`DROP SERVICE IF EXISTS ${s}.${run.currentJob}`)
      } catch (e) {
        console.warn(new Date().toISOString(), "[api/cancel] drop job failed", e)
      }
    }
    return Response.json({ status: "CANCEL_REQUESTED" })
  } catch (e) {
    console.error(new Date().toISOString(), "[api/runs/:id/cancel]", e)
    return Response.json({ error: e instanceof Error ? e.message : "Failed to cancel" }, { status: 500 })
  }
}
