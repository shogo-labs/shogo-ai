/**
 * ToolTimeline Component
 * Task: task-chat-005
 *
 * Vertical tool timeline showing recent tool calls with gradient fade.
 * Collapsible with ToolPill summary in collapsed state.
 */

import { useState } from "react"
import { cn } from "@/lib/utils"
import { ChevronUp } from "lucide-react"
import { type ToolCallData, GRADIENT_CONFIG, getGradientOpacity } from "./types"
import { ToolCallDetail } from "./ToolCallDetail"
import { ToolPill } from "./ToolPill"
import { useReducedMotion } from "@/hooks/useReducedMotion"

export interface ToolTimelineProps {
  /** Array of tool calls to display */
  tools: ToolCallData[]
  /** Whether timeline starts expanded */
  defaultExpanded?: boolean
  /** Optional class name */
  className?: string
}

/**
 * Vertical timeline showing tool call history.
 *
 * Features:
 * - Shows last 5 tools with gradient fade (100% -> 40% opacity)
 * - Collapsible with ToolPill summary
 * - 300ms ease-out transition for expand/collapse
 * - Full timeline visible when expanded
 *
 * @example
 * ```tsx
 * <ToolTimeline tools={extractedToolCalls} defaultExpanded={false} />
 * ```
 */
export function ToolTimeline({
  tools,
  defaultExpanded = false,
  className,
}: ToolTimelineProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)
  const prefersReducedMotion = useReducedMotion()

  if (tools.length === 0) {
    return null
  }

  // Get tools to display (last N in collapsed, all in expanded)
  const displayTools = isExpanded
    ? tools
    : tools.slice(-GRADIENT_CONFIG.maxItems)

  // Reverse for display (most recent first)
  const sortedTools = [...displayTools].reverse()

  return (
    <div className={cn("rounded-md overflow-hidden", className)}>
      {/* Collapsed state: show ToolPill */}
      {!isExpanded && (
        <ToolPill
          tools={tools}
          onClick={() => setIsExpanded(true)}
        />
      )}

      {/* Expanded state: show full timeline */}
      {isExpanded && (
        <div
          className={cn(
            "bg-muted/30 rounded-md border border-border/50",
            !prefersReducedMotion && "panel-transition"
          )}
        >
          {/* Header with collapse button */}
          <div className="flex items-center justify-between px-2 py-1.5 border-b border-border/30">
            <span className="text-xs font-medium text-muted-foreground">
              Tool Timeline ({tools.length})
            </span>
            <button
              type="button"
              onClick={() => setIsExpanded(false)}
              className="p-0.5 rounded hover:bg-muted transition-colors"
              aria-label="Collapse timeline"
            >
              <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
          </div>

          {/* Tool list with gradient fade */}
          <div className="py-1 max-h-64 overflow-y-auto">
            {sortedTools.map((tool, index) => {
              // Calculate opacity for gradient effect (collapsed view only)
              const opacity = isExpanded ? 1 : getGradientOpacity(index)

              return (
                <ToolCallDetail
                  key={`timeline-${tool.id}`}
                  tool={tool}
                  opacity={opacity}
                />
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

export default ToolTimeline
