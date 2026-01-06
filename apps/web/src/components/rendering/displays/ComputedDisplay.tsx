/**
 * ComputedDisplay - Shows computed/derived values with read-only indicator
 * Task: task-display-renderers
 */

import { observer } from "mobx-react-lite"
import type { DisplayRendererProps } from "../types"

export const ComputedDisplay = observer(function ComputedDisplay({
  value
}: DisplayRendererProps) {
  if (value == null) {
    return <span className="text-muted-foreground italic">-</span>
  }

  const displayValue = typeof value === "object"
    ? JSON.stringify(value)
    : String(value)

  return (
    <span
      className="inline-flex items-center gap-1 text-muted-foreground italic"
      title="Computed value (read-only)"
    >
      <svg
        className="w-3 h-3"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z"
        />
      </svg>
      {displayValue}
    </span>
  )
})
