/**
 * EmailDisplay - Renders email as mailto link
 * Task: task-display-renderers
 */

import { observer } from "mobx-react-lite"
import type { DisplayRendererProps } from "../types"

export const EmailDisplay = observer(function EmailDisplay({
  value
}: DisplayRendererProps) {
  if (value == null) {
    return <span className="text-muted-foreground">-</span>
  }

  const email = String(value)

  return (
    <a
      href={`mailto:${email}`}
      className="text-primary hover:underline"
    >
      {email}
    </a>
  )
})
