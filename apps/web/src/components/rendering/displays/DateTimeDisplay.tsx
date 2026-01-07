/**
 * DateTimeDisplay - Renders ISO date strings in human-readable format
 * Task: task-display-renderers
 */

import { observer } from "mobx-react-lite"
import type { DisplayRendererProps } from "../types"

export const DateTimeDisplay = observer(function DateTimeDisplay({
  value
}: DisplayRendererProps) {
  if (value == null) {
    return <span className="text-muted-foreground">-</span>
  }

  const dateStr = String(value)
  const date = new Date(dateStr)

  if (isNaN(date.getTime())) {
    return <span className="text-muted-foreground">{dateStr}</span>
  }

  const formatted = date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  })

  return (
    <span className="text-foreground" title={dateStr}>
      {formatted}
    </span>
  )
})
