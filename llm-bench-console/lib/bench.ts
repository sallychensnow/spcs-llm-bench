import { querySnowflake } from "@/lib/snowflake"
import {
  DEFAULT_SLA,
  evaluateSla,
  type ColdStart,
  type LogEvent,
  type ResultPoint,
  type Run,
  type Sla,
  type Target,
  type TestName,
} from "@/lib/bench-shared"

export * from "@/lib/bench-shared"

/**
 * Bench backend location. All bench objects (BENCH_TARGETS, BENCH_RUNS, BENCH_RESULTS, the
 * BENCH_RUNNER task, ...) live in one schema, set via the BENCH_SCHEMA env var in app.yml.
 */
export function benchSchema(): string {
  const s = process.env.BENCH_SCHEMA ?? ""
  if (!/^[A-Za-z0-9_$]+\.[A-Za-z0-9_$]+$/.test(s)) {
    throw new Error("BENCH_SCHEMA must be set to <DATABASE>.<SCHEMA> (see app.yml)")
  }
  return s
}

export function toIso(val: unknown): string | null {
  if (val === null || val === undefined) return null
  if (val instanceof Date) return val.toISOString()
  return String(val)
}

function parseJson<T>(val: unknown, fallback: T): T {
  if (val === null || val === undefined) return fallback
  if (typeof val === "string") {
    try {
      return JSON.parse(val) as T
    } catch {
      return fallback
    }
  }
  return val as T
}

export async function listTargets(): Promise<Target[]> {
  const rows = await querySnowflake(
    `SELECT TARGET_NAME, SERVICE_FQN, BASE_URL, MODEL, CLIENT_POOL, ALLOW_DISRUPTIVE, DESCRIPTION
       FROM ${benchSchema()}.BENCH_TARGETS ORDER BY TARGET_NAME`,
  )
  return rows.map((r) => ({
    name: r.TARGET_NAME,
    serviceFqn: r.SERVICE_FQN,
    baseUrl: r.BASE_URL,
    model: r.MODEL,
    clientPool: r.CLIENT_POOL,
    allowDisruptive: Boolean(r.ALLOW_DISRUPTIVE),
    description: r.DESCRIPTION ?? null,
  }))
}

function mapRun(r: Record<string, any>): Run {
  return {
    runId: r.RUN_ID,
    target: r.TARGET_NAME,
    tests: parseJson<TestName[]>(r.TESTS, []),
    levels: r.LEVELS,
    minPrompts: Number(r.MIN_PROMPTS),
    sla: { ...DEFAULT_SLA, ...parseJson<Partial<Sla>>(r.SLA, {}) },
    confirmDisruptive: Boolean(r.CONFIRM_DISRUPTIVE),
    status: r.STATUS,
    currentStep: r.CURRENT_STEP ?? null,
    currentJob: r.CURRENT_JOB ?? null,
    note: r.NOTE ?? null,
    requestedBy: r.REQUESTED_BY ?? null,
    requestedAt: toIso(r.REQUESTED_AT),
    startedAt: toIso(r.STARTED_AT),
    finishedAt: toIso(r.FINISHED_AT),
    error: r.ERROR ?? null,
  }
}

const RUN_COLUMNS = `RUN_ID, TARGET_NAME, TESTS, LEVELS, MIN_PROMPTS, SLA, CONFIRM_DISRUPTIVE, STATUS, CURRENT_STEP,
  CURRENT_JOB, NOTE, REQUESTED_BY, REQUESTED_AT, STARTED_AT, FINISHED_AT, ERROR`

export async function listRuns(limit = 50): Promise<Run[]> {
  const rows = await querySnowflake(
    `SELECT ${RUN_COLUMNS} FROM ${benchSchema()}.BENCH_RUNS ORDER BY REQUESTED_AT DESC LIMIT ?`,
    { binds: [limit] },
  )
  return rows.map(mapRun)
}

export async function getRun(runId: string): Promise<Run | null> {
  const rows = await querySnowflake(
    `SELECT ${RUN_COLUMNS} FROM ${benchSchema()}.BENCH_RUNS WHERE RUN_ID = ?`,
    { binds: [runId] },
  )
  return rows[0] ? mapRun(rows[0]) : null
}

export async function getRunLog(runId: string): Promise<LogEvent[]> {
  const rows = await querySnowflake(
    `SELECT test, replicas, event, ts, detail FROM ${benchSchema()}.BENCH_RUN_LOG WHERE run_id = ? ORDER BY ts`,
    { binds: [runId] },
  )
  return rows.map((r) => ({
    test: r.TEST,
    replicas: Number(r.REPLICAS),
    event: r.EVENT,
    ts: toIso(r.TS),
    detail: parseJson<any>(r.DETAIL, null),
  }))
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v))

export async function getResults(runId: string, sla: Sla): Promise<ResultPoint[]> {
  // BENCH_RAW is append-only; QUALIFY keeps the latest load of each result file.
  const rows = await querySnowflake(
    `SELECT * FROM ${benchSchema()}.BENCH_RESULTS WHERE run_id = ?
      QUALIFY ROW_NUMBER() OVER (PARTITION BY test, label, input_len, output_len, concurrency ORDER BY loaded_at DESC) = 1
      ORDER BY test, label, concurrency`,
    { binds: [runId] },
  )
  return rows.map((r) => {
    const p = {
      test: r.TEST,
      label: r.LABEL,
      inputLen: num(r.INPUT_LEN),
      outputLen: num(r.OUTPUT_LEN),
      concurrency: Number(r.CONCURRENCY),
      numPrompts: Number(r.NUM_PROMPTS),
      completed: Number(r.COMPLETED),
      failed: Number(r.FAILED),
      durationS: num(r.DURATION_S),
      reqPerS: num(r.REQ_PER_S),
      outTokPerS: num(r.OUT_TOK_PER_S),
      ttftP50: num(r.TTFT_P50_S),
      ttftP95: num(r.TTFT_P95_S),
      ttftP99: num(r.TTFT_P99_S),
      tpotP50: num(r.TPOT_P50_MS),
      tpotP95: num(r.TPOT_P95_MS),
      tokPerReqP95: num(r.PER_REQ_TOK_S_P95),
      e2eP50: num(r.E2E_P50_S),
      e2eP95: num(r.E2E_P95_S),
    }
    return { ...p, ...evaluateSla(p, sla) }
  })
}

export async function getColdStart(runId: string): Promise<ColdStart[]> {
  const rows = await querySnowflake(
    `SELECT mode, models_ready_s, first_response_s, resume_to_probe_s FROM ${benchSchema()}.BENCH_COLDSTART WHERE run_id = ?`,
    { binds: [runId] },
  )
  return rows.map((r) => ({
    mode: r.MODE,
    modelsReadyS: num(r.MODELS_READY_S),
    firstResponseS: num(r.FIRST_RESPONSE_S),
    resumeToProbeS: num(r.RESUME_TO_PROBE_S),
  }))
}

/** Start the queue runner. If it is already executing, the running instance picks up queued runs. */
export async function kickRunner(): Promise<{ started: boolean; message?: string }> {
  try {
    await querySnowflake(`EXECUTE TASK ${benchSchema()}.BENCH_RUNNER`)
    return { started: true }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.warn(new Date().toISOString(), "[bench] EXECUTE TASK:", message)
    return { started: false, message }
  }
}
