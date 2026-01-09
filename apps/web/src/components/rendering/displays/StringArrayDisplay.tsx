/**
 * StringArrayDisplay - Renders string arrays as styled lists
 *
 * Supports XRendererConfig:
 * - size: xs, sm, md, lg, xl
 * - variant: default, muted, emphasized, warning, success, error
 * - layout: inline (comma-separated), block (bulleted list), compact (tight bullets)
 * - expandable: boolean (show expand/collapse for long lists)
 *
 * CustomProps:
 * - numbered: boolean (use numbers instead of bullets)
 * - maxItems: number (items to show before truncating, default: 5)
 * - collapsible: boolean (start collapsed if > maxItems)
 *
 * Task: smart-component-expansion
 */

import { useState } from "react"
import { observer } from "mobx-react-lite"
import { cn } from "@/lib/utils"
import { ChevronDown, ChevronRight } from "lucide-react"
import type { DisplayRendererProps, XRendererConfig } from "../types"

interface StringArrayCustomProps {
  numbered?: boolean
  maxItems?: number
  collapsible?: boolean
  sectionLabel?: string
}

const DEFAULT_MAX_ITEMS = 5

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

function StringArrayDisplayComponent({
  value,
  config = {}
}: DisplayRendererProps) {
  const customProps = (config.customProps ?? {}) as StringArrayCustomProps
  const maxItems = customProps.maxItems ?? DEFAULT_MAX_ITEMS
  const numbered = customProps.numbered ?? false
  const collapsible = customProps.collapsible ?? false
  const sectionLabel = customProps.sectionLabel
  const layout = config.layout ?? "block"

  // Handle null/undefined/non-array values
  const items = Array.isArray(value) ? value : []

  const [expanded, setExpanded] = useState(!collapsible)

  // Empty state
  if (items.length === 0) {
    const className = cn(
      variantClasses.muted,
      sizeClasses[config.size ?? "md"]
    )
    return <span className={className}>-</span>
  }

  const baseClassName = cn(
    variantClasses[config.variant ?? "default"],
    sizeClasses[config.size ?? "md"]
  )

  // Inline layout: comma-separated
  if (layout === "inline") {
    const displayItems = expanded ? items : items.slice(0, maxItems)
    const hasMore = items.length > maxItems && !expanded

    return (
      <span className={baseClassName}>
        {sectionLabel && (
          <span className="font-medium mr-1">{sectionLabel}:</span>
        )}
        {displayItems.join(", ")}
        {hasMore && (
          <button
            onClick={() => setExpanded(true)}
            className="ml-1 text-blue-500 hover:underline"
          >
            +{items.length - maxItems} more
          </button>
        )}
      </span>
    )
  }

  // Block/Compact layout: list format
  const displayItems = expanded ? items : items.slice(0, maxItems)
  const hasMore = items.length > maxItems && !expanded
  const ListTag = numbered ? "ol" : "ul"

  const listClassName = cn(
    baseClassName,
    layout === "compact" ? "space-y-0.5" : "space-y-1",
    numbered ? "list-decimal" : "list-disc",
    "pl-4"
  )

  const toggleExpand = () => {
    if (items.length > maxItems) {
      setExpanded(!expanded)
    }
  }

  return (
    <div className={baseClassName}>
      {sectionLabel && (
        <button
          onClick={toggleExpand}
          className={cn(
            "flex items-center gap-1 font-medium mb-1",
            items.length > maxItems && "cursor-pointer hover:text-blue-500"
          )}
        >
          {items.length > maxItems && (
            expanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )
          )}
          {sectionLabel}
          <span className="text-muted-foreground font-normal">({items.length})</span>
        </button>
      )}
      <ListTag className={listClassName}>
        {displayItems.map((item, index) => (
          <li key={index} className={layout === "compact" ? "leading-tight" : ""}>
            {item}
          </li>
        ))}
      </ListTag>
      {hasMore && !sectionLabel && (
        <button
          onClick={() => setExpanded(true)}
          className="mt-1 text-sm text-blue-500 hover:underline"
        >
          Show {items.length - maxItems} more...
        </button>
      )}
      {expanded && items.length > maxItems && !sectionLabel && (
        <button
          onClick={() => setExpanded(false)}
          className="mt-1 text-sm text-blue-500 hover:underline"
        >
          Show less
        </button>
      )}
    </div>
  )
}

export const StringArrayDisplay = observer(StringArrayDisplayComponent) as typeof StringArrayDisplayComponent & {
  supportedConfig: string[]
}

StringArrayDisplay.supportedConfig = ["size", "variant", "layout", "expandable"]
