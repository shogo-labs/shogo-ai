/**
 * LongTextDisplay - Renders long text with line clamping and expand/collapse
 *
 * Supports XRendererConfig:
 * - size: xs, sm, md, lg, xl
 * - variant: default, muted, emphasized, warning, success, error
 * - truncate: number (default: 150) - character limit before truncation
 * - expandable: boolean (default: true) - show expand/collapse toggle
 *
 * Task: smart-component-expansion
 */

import { useState } from "react"
import { observer } from "mobx-react-lite"
import { cn } from "@/lib/utils"
import { ChevronDown, ChevronUp } from "lucide-react"
import type { DisplayRendererProps, XRendererConfig } from "../types"

const DEFAULT_TRUNCATE = 150

const sizeClasses: Record<NonNullable<XRendererConfig["size"]>, string> = {
  xs: "text-xs",
  sm: "text-sm",
  md: "text-base",
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

function LongTextDisplayComponent({
  value,
  config = {}
}: DisplayRendererProps) {
  const [expanded, setExpanded] = useState(false)

  const truncateLen = typeof config.truncate === "number"
    ? config.truncate
    : config.truncate === false
      ? undefined
      : DEFAULT_TRUNCATE

  const expandable = config.expandable ?? true

  // Handle null/undefined values
  if (value == null || value === "") {
    return (
      <span className={cn("text-muted-foreground", sizeClasses[config.size ?? "md"])}>
        -
      </span>
    )
  }

  const text = String(value)
  const needsTruncation = truncateLen !== undefined && text.length > truncateLen
  const displayText = needsTruncation && !expanded
    ? `${text.slice(0, truncateLen)}...`
    : text

  const baseClassName = cn(
    variantClasses[config.variant ?? "default"],
    sizeClasses[config.size ?? "md"]
  )

  // Simple case: no truncation needed
  if (!needsTruncation) {
    return <span className={baseClassName}>{text}</span>
  }

  // With truncation
  return (
    <div className={baseClassName}>
      <span className="whitespace-pre-wrap">{displayText}</span>
      {expandable && (
        <button
          onClick={() => setExpanded(!expanded)}
          className={cn(
            "inline-flex items-center gap-0.5 ml-1",
            "text-blue-500 hover:text-blue-600 hover:underline",
            sizeClasses[config.size ?? "md"]
          )}
        >
          {expanded ? (
            <>
              Show less
              <ChevronUp className="h-3 w-3" />
            </>
          ) : (
            <>
              Show more
              <ChevronDown className="h-3 w-3" />
            </>
          )}
        </button>
      )}
    </div>
  )
}

export const LongTextDisplay = observer(LongTextDisplayComponent) as typeof LongTextDisplayComponent & {
  supportedConfig: string[]
}

LongTextDisplay.supportedConfig = ["size", "variant", "truncate", "expandable"]
