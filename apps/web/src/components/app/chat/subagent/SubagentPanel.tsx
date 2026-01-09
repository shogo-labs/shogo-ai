/**
 * SubagentPanel Component
 * Task: task-chat-006
 *
 * Inline subagent panel within TurnGroup.
 * Shows expandable stats for subagent execution.
 */

import { useState } from "react"
import { cn } from "@/lib/utils"
import { ChevronDown, ChevronUp, Bot } from "lucide-react"
import { SubagentStats, type RecentTool } from "./SubagentStats"
import { useReducedMotion } from "@/hooks/useReducedMotion"

export interface SubagentProgress {
  agentId: string
  agentType: string
  startTime: number
  status: "running" | "completed"
  toolCount: number
}

export interface SubagentPanelProps {
  /** Active subagents to display */
  subagents: SubagentProgress[]
  /** Recent tool calls for activity timeline */
  recentTools: RecentTool[]
  /** Whether panel starts expanded */
  defaultExpanded?: boolean
  /** Optional class name */
  className?: string
}

/**
 * Inline panel showing subagent progress within a conversation turn.
 *
 * Features:
 * - Renders inline (not floating)
 * - Expandable with 300ms transition
 * - Supports multiple concurrent subagents
 * - Shows live running time and tool activity
 *
 * @example
 * ```tsx
 * <SubagentPanel
 *   subagents={activeSubagents}
 *   recentTools={recentTools}
 *   defaultExpanded={true}
 * />
 * ```
 */
export function SubagentPanel({
  subagents,
  recentTools,
  defaultExpanded = true,
  className,
}: SubagentPanelProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)
  const prefersReducedMotion = useReducedMotion()

  // Show all subagents (running and completed) with status-based styling
  const runningCount = subagents.filter((s) => s.status === "running").length
  const completedCount = subagents.filter((s) => s.status === "completed").length

  if (subagents.length === 0) {
    return null
  }

  return (
    <div
      className={cn(
        "rounded-md border border-border/50 bg-gradient-to-b from-muted/40 to-muted/20",
        "overflow-hidden",
        !prefersReducedMotion && "panel-transition",
        className
      )}
    >
      {/* Header */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className={cn(
          "w-full flex items-center justify-between px-3 py-2",
          "hover:bg-muted/30 transition-colors"
        )}
      >
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "w-2 h-2 rounded-full",
              runningCount > 0
                ? "bg-exec-streaming animate-pulse"
                : "bg-exec-success"
            )}
          />
          <span className="text-xs font-semibold text-foreground/80">
            {runningCount > 0
              ? `Running Subagent${subagents.length > 1 ? "s" : ""}`
              : `Subagent${subagents.length > 1 ? "s" : ""} Complete`}
          </span>
          {subagents.length > 1 && (
            <span className="text-xs text-muted-foreground">
              ({subagents.length})
            </span>
          )}
        </div>

        {isExpanded ? (
          <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
        )}
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div className="px-3 pb-3 space-y-3">
          {subagents.map((subagent) => {
            const isRunning = subagent.status === "running"

            return (
              <div
                key={subagent.agentId}
                className={cn(
                  "pl-3 border-l-2",
                  isRunning ? "border-exec-streaming/30" : "border-exec-success/30"
                )}
              >
                {/* Subagent type badge */}
                <div className="flex items-center gap-2 mb-2">
                  <Bot
                    className={cn(
                      "w-3.5 h-3.5",
                      isRunning ? "text-exec-streaming" : "text-exec-success"
                    )}
                  />
                  <span
                    className={cn(
                      "text-xs font-medium px-2 py-0.5 rounded",
                      isRunning
                        ? "text-exec-streaming bg-exec-streaming/10"
                        : "text-exec-success bg-exec-success/10"
                    )}
                  >
                    {subagent.agentType}
                  </span>
                  {!isRunning && (
                    <span className="text-xs text-muted-foreground">
                      (complete)
                    </span>
                  )}
                </div>

                {/* Stats */}
                <SubagentStats
                  status={subagent.status}
                  startTime={subagent.startTime}
                  toolCount={subagent.toolCount}
                  recentTools={recentTools}
                />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default SubagentPanel
