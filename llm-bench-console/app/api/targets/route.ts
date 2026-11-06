import { listTargets } from "@/lib/bench"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    return Response.json({ targets: await listTargets() })
  } catch (e) {
    console.error(new Date().toISOString(), "[api/targets]", e)
    return Response.json({ error: e instanceof Error ? e.message : "Failed to load targets" }, { status: 500 })
  }
}
