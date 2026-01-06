/**
 * SessionStatusBadge - Domain renderer for FeatureSession.status
 * Task: task-variants
 *
 * Renders session status enum values with semantic coloring.
 * Phases: discovery, analysis, classification, design, spec, implementation, testing, complete
 */

import { observer } from "mobx-react-lite"
import { Badge } from "@/components/ui/badge"
import { sessionStatusBadgeVariants } from "./variants"
import type { DisplayRendererProps } from "../../types"

type SessionStatus = "discovery" | "analysis" | "classification" | "design" | "spec" | "implementation" | "testing" | "complete"

export const SessionStatusBadge = observer(function SessionStatusBadge({
  value,
}: DisplayRendererProps) {
  if (value == null) {
    return <span className="text-muted-foreground">-</span>
  }

  const status = String(value) as SessionStatus

  return (
    <Badge className={sessionStatusBadgeVariants({ status })}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </Badge>
  )
})
