/**
 * TestTypeBadge - Domain renderer for TestSpecification.testType
 * Task: task-variants
 *
 * Renders test type enum values (unit, integration, acceptance) with semantic coloring.
 */

import { observer } from "mobx-react-lite"
import { Badge } from "@/components/ui/badge"
import { testTypeBadgeVariants } from "./variants"
import type { DisplayRendererProps } from "../../types"

type TestType = "unit" | "integration" | "acceptance"

export const TestTypeBadge = observer(function TestTypeBadge({
  value,
}: DisplayRendererProps) {
  if (value == null) {
    return <span className="text-muted-foreground">-</span>
  }

  const testType = String(value) as TestType

  return (
    <Badge className={testTypeBadgeVariants({ testType })}>
      {testType.charAt(0).toUpperCase() + testType.slice(1)}
    </Badge>
  )
})
