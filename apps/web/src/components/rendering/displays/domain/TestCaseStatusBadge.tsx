/**
 * TestCaseStatusBadge - Domain renderer for TestCase.status
 * Task: task-variants
 *
 * Renders test case status enum values (specified, implemented, passing) with semantic coloring.
 */

import { observer } from "mobx-react-lite"
import { Badge } from "@/components/ui/badge"
import { testCaseStatusBadgeVariants } from "./variants"
import type { DisplayRendererProps } from "../../types"

type TestCaseStatus = "specified" | "implemented" | "passing"

export const TestCaseStatusBadge = observer(function TestCaseStatusBadge({
  value,
}: DisplayRendererProps) {
  if (value == null) {
    return <span className="text-muted-foreground">-</span>
  }

  const status = String(value) as TestCaseStatus

  return (
    <Badge className={testCaseStatusBadgeVariants({ status })}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </Badge>
  )
})
