import { listTargets } from "@/lib/bench"
import { PageHeader } from "@/components/page-header"
import { EmptyState } from "@/components/empty-state"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

export const dynamic = "force-dynamic"

export default async function Page() {
  let targets: Awaited<ReturnType<typeof listTargets>> = []
  let error: string | null = null
  try {
    targets = await listTargets()
  } catch (e) {
    console.error(new Date().toISOString(), "[targets page]", e)
    error = e instanceof Error ? e.message : "Failed to load targets"
  }

  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <PageHeader
        eyebrow="Targets"
        title="Registered PoC services"
        description="The console can only test services listed here. Administrators manage this list in the BENCH_TARGETS table; production endpoints must never be registered."
      />
      <Card>
        <CardContent className="p-0">
          {error ? (
            <div className="p-6">
              <EmptyState variant="error" title="Could not load targets" description={error} />
            </div>
          ) : targets.length === 0 ? (
            <div className="p-6">
              <EmptyState title="No targets registered" description="Insert a row into BENCH_TARGETS (see targets_example.sql)." />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Service</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Endpoint</TableHead>
                  <TableHead>Client pool</TableHead>
                  <TableHead>Disruptive</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {targets.map((t) => (
                  <TableRow key={t.name}>
                    <TableCell className="font-medium">
                      {t.name}
                      {t.description && <div className="max-w-xs text-xs font-normal text-muted-foreground">{t.description}</div>}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{t.serviceFqn}</TableCell>
                    <TableCell>{t.model}</TableCell>
                    <TableCell className="font-mono text-xs">{t.baseUrl}</TableCell>
                    <TableCell className="font-mono text-xs">{t.clientPool}</TableCell>
                    <TableCell>{t.allowDisruptive ? <Badge variant="warning">allowed</Badge> : <Badge variant="outline">no</Badge>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </main>
  )
}
