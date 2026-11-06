import { kickRunner } from "@/lib/bench"

export const dynamic = "force-dynamic"

/** Manually start the queue runner (e.g. a run stayed QUEUED because the runner was finishing). */
export async function POST() {
  return Response.json(await kickRunner())
}
