import { getOverview } from "@/lib/monitor"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const days = Number(new URL(req.url).searchParams.get("days") ?? 7)
  try {
    return Response.json(await getOverview(Number.isInteger(days) && days >= 1 && days <= 90 ? days : 7))
  } catch (e) {
    console.error(new Date().toISOString(), "[api/monitor]", e)
    return Response.json({ error: e instanceof Error ? e.message : "Failed to load monitor overview" }, { status: 500 })
  }
}
