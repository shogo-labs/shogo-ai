/**
 * StringDisplay - Renders string values with optional truncation
 * Task: task-display-renderers
 */

import { observer } from "mobx-react-lite"
import type { DisplayRendererProps } from "../types"

const MAX_LENGTH = 200

export const StringDisplay = observer(function StringDisplay({
  value
}: DisplayRendererProps) {
  if (value == null) {
    return <span className="text-muted-foreground">-</span>
  }

  const text = String(value)
  const truncated = text.length > MAX_LENGTH

  return (
    <span className="text-foreground">
      {truncated ? `${text.slice(0, MAX_LENGTH)}...` : text}
    </span>
  )
})
