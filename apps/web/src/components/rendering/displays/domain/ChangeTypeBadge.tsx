/**
 * ChangeTypeBadge - Domain renderer for IntegrationPoint.changeType
 * Task: task-cbe-001
 *
 * Renders changeType enum values (add, modify, extend, remove) with semantic coloring.
 * - add: green (new file/feature)
 * - modify: blue (changes to existing)
 * - extend: purple (additions to existing patterns)
 * - remove: red (deletions)
 */

import { observer } from "mobx-react-lite"
import { Badge } from "@/components/ui/badge"
import { changeTypeBadgeVariants } from "./variants"
import type { DisplayRendererProps } from "../../types"

type ChangeType = "add" | "modify" | "extend" | "remove"

/**
 * Capitalize first letter for display
 */
function formatChangeType(changeType: string): string {
  return changeType.charAt(0).toUpperCase() + changeType.slice(1)
}

export const ChangeTypeBadge = observer(function ChangeTypeBadge({
  value,
}: DisplayRendererProps) {
  if (value == null) {
    return <span className="text-muted-foreground">-</span>
  }

  const changeType = String(value) as ChangeType

  return (
    <Badge className={changeTypeBadgeVariants({ changeType })}>
      {formatChangeType(changeType)}
    </Badge>
  )
})

export default ChangeTypeBadge
