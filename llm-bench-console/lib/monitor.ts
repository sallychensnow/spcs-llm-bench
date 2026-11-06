import { querySnowflake } from "@/lib/snowflake"
import { callersRightsActive, isCallerAccessError, quoteIdent } from "@/lib/run-as"
import { toIso } from "@/lib/bench"
import {
  isGpuFamily,
  windowFor,
  type Identity,
  type MetricPoint,
  type NotebookCredits,
  type Overview,
  type PlatformEvent,
  type Pool,
  type PoolCredits,
  type Section,
  type ServiceTelemetry,
  type Workload,
  type WorkloadKind,
} from "@/lib/monitor-shared"

export * from "@/lib/monitor-shared"

type QueryOptions = NonNullable<Parameters<typeof querySnowflake>[1]>

/**
 * Runs each section as the viewer (caller's rights) so people only see the pools and
 * services their own role can see. A section the viewer has no grants for falls back to
 * the app's role; any other failure is reported on that section without failing the page.
 */
class SectionRunner {
  fellBack = false

  identity(): Identity {
    if (!callersRightsActive()) return "dev"
    return this.fellBack ? "service" : "caller"
  }

  async run<T>(
    label: string,
    empty: T,
    load: (opts: QueryOptions) => Promise<T>,
    fallbackOnEmpty = false,
  ): Promise<Section<T>> {
    try {
      if (!callersRightsActive()) return { data: await load({}), error: null }
      try {
        const data = await load({ callersRights: true })
        // SHOW commands return no rows (not an error) when the caller grants of the app's role
        // do not cover any object, so an empty list also falls back to the app's role.
        if (fallbackOnEmpty && Array.isArray(data) && data.length === 0) {
          this.fellBack = true
          return { data: await load({}), error: null }
        }
        return { data, error: null }
      } catch (e) {
        if (!isCallerAccessError(e)) throw e
        this.fellBack = true
        return { data: await load({}), error: null }
      }
    } catch (e) {
      console.error(new Date().toISOString(), `[monitor] ${label}`, e)
      return { data: empty, error: e instanceof Error ? e.message : String(e) }
    }
  }
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v))
const bool = (v: unknown): boolean => v === true || String(v).toLowerCase() === "true"
const str = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v))

function workloadKind(r: Record<string, any>): WorkloadKind {
  const domain = String(r.managing_object_domain ?? "")
  if (/notebook/i.test(domain)) return "Notebook"
  if (/streamlit/i.test(domain)) return "Streamlit"
  if (/application|app/i.test(domain)) return "App"
  if (bool(r.is_job)) return "Job"
  if (domain) return "Other"
  return "Service"
}

async function loadPools(opts: QueryOptions): Promise<Pool[]> {
  const rows = await querySnowflake("SHOW COMPUTE POOLS", opts)
  return rows
    .map((r) => ({
      name: r.name,
      state: r.state,
      instanceFamily: r.instance_family,
      isGpu: isGpuFamily(String(r.instance_family ?? "")),
      minNodes: Number(r.min_nodes ?? 0),
      maxNodes: Number(r.max_nodes ?? 0),
      activeNodes: Number(r.active_nodes ?? 0),
      idleNodes: Number(r.idle_nodes ?? 0),
      targetNodes: Number(r.target_nodes ?? 0),
      numServices: Number(r.num_services ?? 0),
      numJobs: Number(r.num_jobs ?? 0),
      autoSuspendSecs: num(r.auto_suspend_secs),
      autoResume: bool(r.auto_resume),
      owner: str(r.owner),
      resumedOn: toIso(r.resumed_on),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function mapWorkload(r: Record<string, any>): Workload {
  return {
    name: r.name,
    database: r.database_name,
    schema: r.schema_name,
    pool: r.compute_pool ?? "",
    status: r.status,
    kind: workloadKind(r),
    managedBy: str(r.managing_object_name),
    owner: str(r.owner),
    currentInstances: num(r.current_instances),
    targetInstances: num(r.target_instances),
    minInstances: num(r.min_instances),
    maxInstances: num(r.max_instances),
    createdOn: toIso(r.created_on),
    resumedOn: toIso(r.resumed_on),
  }
}

async function loadWorkloads(opts: QueryOptions): Promise<Workload[]> {
  const rows = await querySnowflake("SHOW SERVICES IN ACCOUNT", opts)
  return rows.map(mapWorkload)
}

async function loadCredits(opts: QueryOptions, days: number): Promise<PoolCredits[]> {
  const rows = await querySnowflake(
    `SELECT TO_VARCHAR(DATE_TRUNC('day', start_time), 'YYYY-MM-DD') AS day, compute_pool_name AS pool,
            SUM(credits_used) AS credits
       FROM SNOWFLAKE.ACCOUNT_USAGE.SNOWPARK_CONTAINER_SERVICES_HISTORY
      WHERE start_time >= DATEADD('day', -?, CURRENT_DATE())
      GROUP BY 1, 2 ORDER BY 1, 2`,
    { ...opts, binds: [days] },
  )
  return rows.map((r) => ({ day: r.DAY, pool: r.POOL, credits: Number(r.CREDITS ?? 0) }))
}

async function loadNotebookCredits(opts: QueryOptions, days: number): Promise<NotebookCredits[]> {
  const rows = await querySnowflake(
    `SELECT COALESCE(notebook_name, service_name) AS notebook, user_name AS usr, compute_pool_name AS pool,
            SUM(credits) AS credits, SUM(notebook_execution_time_secs) / 3600 AS hours
       FROM SNOWFLAKE.ACCOUNT_USAGE.NOTEBOOKS_CONTAINER_RUNTIME_HISTORY
      WHERE start_time >= DATEADD('day', -?, CURRENT_DATE())
      GROUP BY 1, 2, 3 ORDER BY credits DESC LIMIT 50`,
    { ...opts, binds: [days] },
  )
  return rows.map((r) => ({
    notebook: r.NOTEBOOK,
    user: r.USR,
    pool: r.POOL,
    credits: Number(r.CREDITS ?? 0),
    hours: Number(r.HOURS ?? 0),
  }))
}

export async function getOverview(days = 7): Promise<Overview> {
  const runner = new SectionRunner()
  const [pools, workloads, credits, notebooks] = await Promise.all([
    runner.run("pools", [] as Pool[], loadPools, true),
    runner.run("workloads", [] as Workload[], loadWorkloads, true),
    runner.run("credits", [] as PoolCredits[], (o) => loadCredits(o, days)),
    runner.run("notebooks", [] as NotebookCredits[], (o) => loadNotebookCredits(o, days)),
  ])
  return { identity: runner.identity(), pools, workloads, credits, notebooks }
}

export type ServiceRef = { database: string; schema: string; name: string }

function serviceFqn(ref: ServiceRef): string {
  return [ref.database, ref.schema, ref.name].map(quoteIdent).join(".")
}

async function loadMetrics(opts: QueryOptions, ref: ServiceRef, hours: number, bucketMinutes: number): Promise<MetricPoint[]> {
  // Average each series (metric × instance × container × gpu) into fixed buckets so a
  // week of 10-second samples stays a few thousand rows.
  const rows = await querySnowflake(
    `SELECT TO_VARCHAR(TIME_SLICE(timestamp, ?, 'MINUTE'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ts, -- event timestamps are UTC (NTZ)
            metric_name AS metric,
            COALESCE(TO_VARCHAR(instance_id), '') AS inst,
            COALESCE(container_name, '') AS container,
            COALESCE(record_attributes:gpu::string, '') AS gpu,
            AVG(TRY_TO_DOUBLE(TO_VARCHAR(value))) AS v
       FROM TABLE(${serviceFqn(ref)}!SPCS_GET_METRICS(start_time => DATEADD('hour', -?, CURRENT_TIMESTAMP())))
      GROUP BY 1, 2, 3, 4, 5
     HAVING v IS NOT NULL
      ORDER BY 1`,
    { ...opts, binds: [bucketMinutes, hours] },
  )
  return rows.map((r) => ({
    ts: r.TS,
    metric: r.METRIC,
    instance: r.INST,
    container: r.CONTAINER,
    gpu: r.GPU,
    value: Number(r.V),
  }))
}

function parseVariant(v: unknown): Record<string, any> {
  if (v && typeof v === "object") return v as Record<string, any>
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v)
      return p && typeof p === "object" ? p : { message: v }
    } catch {
      return { message: v }
    }
  }
  return {}
}

async function loadEvents(opts: QueryOptions, ref: ServiceRef, hours: number): Promise<PlatformEvent[]> {
  const rows = await querySnowflake(
    `SELECT * FROM TABLE(${serviceFqn(ref)}!SPCS_GET_EVENTS(start_time => DATEADD('hour', -?, CURRENT_TIMESTAMP())))
      ORDER BY timestamp DESC LIMIT 200`,
    { ...opts, binds: [hours] },
  )
  return rows.map((r) => {
    const record = parseVariant(r.RECORD)
    const value = parseVariant(r.VALUE ?? r.EVENT ?? r.DETAIL)
    return {
      ts: toIso(r.TIMESTAMP) ?? "",
      name: String(r.EVENT_NAME ?? record.name ?? ""),
      severity: String(r.SEVERITY ?? record.severity_text ?? ""),
      status: String(r.STATUS ?? value.status ?? ""),
      message: String(r.MESSAGE ?? value.message ?? ""),
      instance: str(r.INSTANCE_ID) ?? "",
      container: str(r.CONTAINER_NAME) ?? "",
    }
  })
}

export async function getServiceTelemetry(ref: ServiceRef, hours: number): Promise<ServiceTelemetry> {
  const w = windowFor(hours)
  const runner = new SectionRunner()
  const [metrics, events] = await Promise.all([
    runner.run("metrics", [] as MetricPoint[], (o) => loadMetrics(o, ref, w.hours, w.bucketMinutes)),
    runner.run("events", [] as PlatformEvent[], (o) => loadEvents(o, ref, w.hours)),
  ])
  return { identity: runner.identity(), hours: w.hours, bucketMinutes: w.bucketMinutes, metrics, events }
}
