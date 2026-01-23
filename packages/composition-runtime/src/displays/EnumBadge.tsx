/**
 * EnumBadge - Renders enum values as styled badges
 * Task: task-display-renderers
 */

import { observer } from "mobx-react-lite"
import type { DisplayRendererProps } from "../types"

// Color variants based on common status values
const getVariantColor = (value: string): string => {
  const lower = value.toLowerCase()

  if (["active", "success", "complete", "done", "enabled", "yes", "true"].includes(lower)) {
    return "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
  }
  if (["inactive", "disabled", "no", "false"].includes(lower)) {
    return "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200"
  }
  if (["error", "failed", "rejected", "blocked"].includes(lower)) {
    return "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
  }
  if (["warning", "pending", "review", "draft"].includes(lower)) {
    return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200"
  }
  if (["info", "processing", "in_progress", "implementation"].includes(lower)) {
    return "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"
  }

  // Default color
  return "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200"
}

export const EnumBadge = observer(function EnumBadge({
  value
}: DisplayRendererProps) {
  if (value == null) {
    return <span className="text-muted-foreground">-</span>
  }

  const text = String(value)
  const colorClass = getVariantColor(text)

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium badge ${colorClass}`}
    >
      {text}
    </span>
  )
})
