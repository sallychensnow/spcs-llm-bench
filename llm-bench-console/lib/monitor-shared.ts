/** Types and pure helpers for the compute-pool monitor, safe to import from client components. */

export type Identity = "caller" | "service" | "dev"

export type Pool = {
  name: string
  state: string
  instanceFamily: string
  isGpu: boolean
  minNodes: number
  maxNodes: number
  activeNodes: number
  idleNodes: number
  targetNodes: number
  numServices: number
  numJobs: number
  autoSuspendSecs: number | null
  autoResume: boolean
  owner: string | null
  resumedOn: string | null
}

export type WorkloadKind = "Service" | "Job" | "Notebook" | "Streamlit" | "App" | "Other"

export type Workload = {
  name: string
  database: string
  schema: string
  pool: string
  status: string
  kind: WorkloadKind
  managedBy: string | null
  owner: string | null
  currentInstances: number | null
  targetInstances: number | null
  minInstances: number | null
  maxInstances: number | null
  createdOn: string | null
  resumedOn: string | null
}

export type PoolCredits = { day: string; pool: string; credits: number }
export type NotebookCredits = { notebook: string; user: string; pool: string; credits: number; hours: number }

/** A section that failed loads independently so the rest of the page still renders. */
export type Section<T> = { data: T; error: string | null }

export type Overview = {
  identity: Identity
  pools: Section<Pool[]>
  workloads: Section<Workload[]>
  credits: Section<PoolCredits[]>
  notebooks: Section<NotebookCredits[]>
}

/** One averaged sample of a metric series. */
export type MetricPoint = {
  ts: string
  metric: string
  instance: string
  container: string
  gpu: string
  value: number
}

export type PlatformEvent = {
  ts: string
  name: string
  severity: string
  status: string
  message: string
  instance: string
  container: string
}

export type ServiceTelemetry = {
  identity: Identity
  hours: number
  bucketMinutes: number
  metrics: Section<MetricPoint[]>
  events: Section<PlatformEvent[]>
}

/** Allowed lookback windows (hours) and the bucket each one uses. */
export const WINDOWS: { hours: number; label: string; bucketMinutes: number }[] = [
  { hours: 1, label: "1h", bucketMinutes: 1 },
  { hours: 6, label: "6h", bucketMinutes: 5 },
  { hours: 24, label: "24h", bucketMinutes: 15 },
  { hours: 168, label: "7d", bucketMinutes: 60 },
]

export function windowFor(hours: number) {
  return WINDOWS.find((w) => w.hours === hours) ?? WINDOWS[1]
}

export function isGpuFamily(family: string): boolean {
  return /^GPU/i.test(family)
}

/** Spec fragment that turns on platform metrics for a service. */
export const PLATFORM_MONITOR_SNIPPET = `spec:
  ...
  platformMonitor:
    metricConfig:
      groups:
      - system         # cpu / memory / gpu utilization / gpu memory
      - system_limits  # requests and limits (reference lines)
      - status         # restarts, pending / finished reasons`
