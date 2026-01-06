/**
 * ArchetypeBadge - Domain renderer for featureArchetype fields
 * Task: task-variants
 *
 * Renders archetype enum values (domain, service, infrastructure, hybrid) with semantic coloring.
 */

import { observer } from "mobx-react-lite"
import { Badge } from "@/components/ui/badge"
import { archetypeBadgeVariants } from "./variants"
import type { DisplayRendererProps } from "../../types"

export const ArchetypeBadge = observer(function ArchetypeBadge({
  value,
}: DisplayRendererProps) {
  if (value == null) {
    return <span className="text-muted-foreground">-</span>
  }

  const archetype = String(value) as "domain" | "service" | "infrastructure" | "hybrid"

  return (
    <Badge className={archetypeBadgeVariants({ archetype })}>
      {archetype}
    </Badge>
  )
})
