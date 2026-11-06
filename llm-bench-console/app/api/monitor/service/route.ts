import { getServiceTelemetry } from "@/lib/monitor"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams
  const database = p.get("database") ?? ""
  const schema = p.get("schema") ?? ""
  const name = p.get("name") ?? ""
  if (!database || !schema || !name) {
    return Response.json({ error: "database, schema and name are required" }, { status: 400 })
  }
  try {
    return Response.json(await getServiceTelemetry({ database, schema, name }, Number(p.get("hours") ?? 6)))
  } catch (e) {
    console.error(new Date().toISOString(), "[api/monitor/service]", e)
    return Response.json({ error: e instanceof Error ? e.message : "Failed to load service telemetry" }, { status: 500 })
  }
}
