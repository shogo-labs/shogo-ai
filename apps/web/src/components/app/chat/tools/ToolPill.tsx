/**
 * ToolPill Component
 * Task: task-chat-005
 *
 * Compact summary pill for collapsed tool timeline.
 * Shows tool count, total duration, and success/error indicator.
 */

import { cn } from "@/lib/utils"
import { Wrench, CheckCircle2, XCircle, ChevronDown } from "lucide-react"
import { type ToolCallData } from "./types"

export interface ToolPillProps {
  /** Array of tool calls to summarize */
  tools: ToolCallData[]
  /** Whether the pill is clickable to expand */
  onClick?: () => void
  /** Optional class name */
  className?: string
}

/**
 * Compact pill showing tool timeline summary.
 *
 * Features:
 * - Tool count badge
 * - Total duration (sum of all tool durations)
 * - Success/error indicator
 * - Click to expand full timeline
 *
 * @example
 * ```tsx
 * <ToolPill tools={toolCalls} onClick={() => setExpanded(true)} />
 * ```
 */
export function ToolPill({ tools, onClick, className }: ToolPillProps) {
  if (tools.length === 0) {
    return null
  }

  // Calculate totals
  const totalDuration = tools.reduce((sum, t) => sum + (t.duration || 0), 0)
  const hasErrors = tools.some((t) => t.state === "error")
  const hasStreaming = tools.some((t) => t.state === "streaming")
  const allSuccess = !hasErrors && !hasStreaming && tools.every((t) => t.state === "success")

  // Format duration for display
  const formatDuration = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(1)}s`
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-1 rounded-md",
        "bg-muted/50 hover:bg-muted transition-colors",
        "text-xs text-muted-foreground",
        onClick && "cursor-pointer",
        !onClick && "cursor-default",
        className
      )}
    >
      {/* Tool icon */}
      <Wrench className="w-3 h-3" />

      {/* Tool count badge */}
      <span className="font-medium text-foreground">{tools.length}</span>
      <span>tool{tools.length !== 1 ? "s" : ""}</span>

      {/* Duration */}
      {totalDuration > 0 && (
        <>
          <span className="text-muted-foreground/50">·</span>
          <span>{formatDuration(totalDuration)}</span>
        </>
      )}

      {/* Status indicator */}
      {hasErrors && (
        <XCircle className="w-3 h-3 text-exec-error" />
      )}
      {allSuccess && (
        <CheckCircle2 className="w-3 h-3 text-exec-success" />
      )}

      {/* Expand indicator */}
      {onClick && (
        <ChevronDown className="w-3 h-3 ml-0.5" />
      )}
    </button>
  )
}

export default ToolPill
