/**
 * StringDisplay - Renders string values with optional truncation
 *
 * Supports XRendererConfig:
 * - size: xs, sm, md, lg, xl
 * - variant: default, muted, emphasized, warning, success, error
 * - truncate: boolean | number (default: 200)
 *
 * Task: task-display-renderers
 * Updated: task-xrenderer-config
 */

import { observer } from "mobx-react-lite"
import { cn } from "../utils/cn"
import type { DisplayRendererProps, XRendererConfig } from "../types"

const DEFAULT_TRUNCATE = 200

const sizeClasses: Record<NonNullable<XRendererConfig["size"]>, string> = {
  xs: "text-xs",
  sm: "text-sm",
  md: "",
  lg: "text-lg",
  xl: "text-xl"
}

const variantClasses: Record<NonNullable<XRendererConfig["variant"]>, string> = {
  default: "",
  muted: "text-muted-foreground",
  emphasized: "font-semibold",
  warning: "text-amber-600",
  success: "text-green-600",
  error: "text-red-600"
}

function StringDisplayComponent({
  value,
  config = {}
}: DisplayRendererProps) {
  // Determine truncation behavior
  // - truncate: false → no truncation
  // - truncate: true → default (200)
  // - truncate: number → that number
  // - truncate: undefined → default (200)
  const truncateLen =
    config.truncate === false
      ? undefined
      : typeof config.truncate === "number"
        ? config.truncate
        : DEFAULT_TRUNCATE

  // Handle null/undefined values
  if (value == null) {
    const className = cn(
      variantClasses[config.variant ?? "muted"],
      sizeClasses[config.size ?? "md"]
    )
    return <span className={className}>-</span>
  }

  const text = String(value)
  const shouldTruncate = truncateLen !== undefined && text.length > truncateLen
  const displayText = shouldTruncate
    ? `${text.slice(0, truncateLen)}...`
    : text

  const className = cn(
    variantClasses[config.variant ?? "default"],
    sizeClasses[config.size ?? "md"]
  )

  return <span className={className}>{displayText}</span>
}

export const StringDisplay = observer(StringDisplayComponent) as unknown as typeof StringDisplayComponent & {
  supportedConfig: string[]
}

StringDisplay.supportedConfig = ["size", "truncate", "variant"]
