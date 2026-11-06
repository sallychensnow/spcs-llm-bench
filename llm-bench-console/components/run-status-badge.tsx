"use client"

import { badgeVariants } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

const STYLES: Record<string, { variant: "default" | "secondary" | "destructive" | "outline" | "success" | "warning"; label: string }> = {
  QUEUED: { variant: "secondary", label: "Queued" },
  RUNNING: { variant: "default", label: "Running" },
  CANCEL_REQUESTED: { variant: "warning", label: "Cancelling" },
  CANCELLED: { variant: "outline", label: "Cancelled" },
  DONE: { variant: "success", label: "Done" },
  DONE_WITH_ERRORS: { variant: "warning", label: "Done with errors" },
  FAILED: { variant: "destructive", label: "Failed" },
}

/** Rendered as a <span> so it can sit inside paragraph text (e.g. PageHeader descriptions). */
export function RunStatusBadge({ status }: { status: string }) {
  const s = STYLES[status] ?? { variant: "outline" as const, label: status }
  return <span className={cn(badgeVariants({ variant: s.variant }), "whitespace-nowrap")}>{s.label}</span>
}
