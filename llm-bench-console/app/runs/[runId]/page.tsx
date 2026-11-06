import { RunDetail } from "@/components/run-detail"

export const dynamic = "force-dynamic"

export default async function Page({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params
  return <RunDetail runId={runId} />
}
