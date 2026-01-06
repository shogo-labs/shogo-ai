/**
 * BooleanDisplay - Renders boolean as Yes/No badge
 * Task: task-display-renderers
 */

import { observer } from "mobx-react-lite"
import type { DisplayRendererProps } from "../types"

export const BooleanDisplay = observer(function BooleanDisplay({
  value
}: DisplayRendererProps) {
  if (value == null) {
    return <span className="text-muted-foreground">-</span>
  }

  const isTrue = Boolean(value)

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
        isTrue
          ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
          : "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
      }`}
    >
      {isTrue ? "Yes" : "No"}
    </span>
  )
})
