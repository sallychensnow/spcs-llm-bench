import { PoolDetail } from "@/components/pool-detail"

export const dynamic = "force-dynamic"

export default async function Page({ params }: { params: Promise<{ pool: string }> }) {
  const { pool } = await params
  return <PoolDetail pool={decodeURIComponent(pool)} />
}
