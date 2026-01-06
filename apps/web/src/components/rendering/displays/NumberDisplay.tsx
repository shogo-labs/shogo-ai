/**
 * NumberDisplay - Renders numbers with locale formatting
 * Task: task-display-renderers
 */

import { observer } from "mobx-react-lite"
import type { DisplayRendererProps } from "../types"

export const NumberDisplay = observer(function NumberDisplay({
  value
}: DisplayRendererProps) {
  if (value == null) {
    return <span className="text-muted-foreground">-</span>
  }

  const num = Number(value)
  if (isNaN(num)) {
    return <span className="text-muted-foreground">-</span>
  }

  return (
    <span className="text-foreground tabular-nums">
      {num.toLocaleString()}
    </span>
  )
})
