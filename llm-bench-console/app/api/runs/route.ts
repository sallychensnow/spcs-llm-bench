import { querySnowflake } from "@/lib/snowflake"
import {
  benchSchema,
  DEFAULT_SLA,
  DISRUPTIVE_TESTS,
  kickRunner,
  LEVELS_RE,
  listRuns,
  listTargets,
  TESTS,
  type TestName,
} from "@/lib/bench"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    return Response.json({ runs: await listRuns() })
  } catch (e) {
    console.error(new Date().toISOString(), "[api/runs GET]", e)
    return Response.json({ error: e instanceof Error ? e.message : "Failed to load runs" }, { status: 500 })
  }
}

type CreateBody = {
  target?: string
  tests?: string[]
  levels?: string
  minPrompts?: number
  sla?: { ttft_p95_s?: number; e2e_p95_s?: number; min_tok_s?: number }
  note?: string
  confirmText?: string
}

function bad(message: string) {
  return Response.json({ error: message }, { status: 400 })
}

function newRunId(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, "0")
  const rand = Math.random().toString(36).slice(2, 6)
  return `r${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}_${rand}`
}

export async function POST(req: Request) {
  let body: CreateBody
  try {
    body = await req.json()
  } catch {
    return bad("Invalid JSON body")
  }

  try {
    const targets = await listTargets()
    const target = targets.find((t) => t.name === body.target)
    if (!target) return bad("Unknown target. Only services registered in BENCH_TARGETS can be tested.")

    const tests = (body.tests ?? []).filter((t): t is TestName => (TESTS as readonly string[]).includes(t))
    if (tests.length === 0) return bad("Select at least one test")

    const levels = (body.levels ?? "").trim().replace(/\s+/g, " ")
    if (!LEVELS_RE.test(levels)) return bad("Concurrency levels must be up to 12 space-separated integers")
    const levelNums = levels.split(" ").map(Number)
    if (levelNums.some((n) => n < 1 || n > 256)) return bad("Each concurrency level must be between 1 and 256")

    const minPrompts = Math.round(Number(body.minPrompts ?? 8))
    if (!Number.isFinite(minPrompts) || minPrompts < 1 || minPrompts > 200) return bad("Min prompts per level must be 1–200")

    const sla = {
      ttft_p95_s: Number(body.sla?.ttft_p95_s ?? DEFAULT_SLA.ttft_p95_s),
      e2e_p95_s: Number(body.sla?.e2e_p95_s ?? DEFAULT_SLA.e2e_p95_s),
      min_tok_s: Number(body.sla?.min_tok_s ?? DEFAULT_SLA.min_tok_s),
    }
    if (Object.values(sla).some((v) => !Number.isFinite(v) || v <= 0 || v > 10000)) return bad("SLA thresholds must be positive numbers")

    const disruptive = tests.some((t) => DISRUPTIVE_TESTS.includes(t))
    if (disruptive) {
      if (!target.allowDisruptive) return bad("This target does not allow cold-start or replica tests")
      if (body.confirmText !== target.name) return bad("Type the target name to confirm the disruptive tests")
    }

    const note = (body.note ?? "").slice(0, 500)
    const runId = newRunId()
    const s = benchSchema()

    await querySnowflake(
      `INSERT INTO ${s}.BENCH_RUNS (RUN_ID, TARGET_NAME, TESTS, LEVELS, MIN_PROMPTS, SLA, CONFIRM_DISRUPTIVE, STATUS, NOTE, REQUESTED_BY)
       SELECT ?, ?, PARSE_JSON(?), ?, ?, PARSE_JSON(?), ?, 'QUEUED', ?, ?`,
      {
        binds: [
          runId,
          target.name,
          JSON.stringify(tests),
          levels,
          minPrompts,
          JSON.stringify(sla),
          disruptive,
          note,
          // Recorded for audit; the identity header is injected by Snowflake on every ingress request.
          req.headers.get("sf-context-current-user") ?? "local-dev",
        ],
      },
    )
    const runner = await kickRunner()
    return Response.json({ runId, runner })
  } catch (e) {
    console.error(new Date().toISOString(), "[api/runs POST]", e)
    return Response.json({ error: e instanceof Error ? e.message : "Failed to create run" }, { status: 500 })
  }
}
