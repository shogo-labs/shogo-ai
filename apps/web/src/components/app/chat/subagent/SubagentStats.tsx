/**
 * SubagentStats Component
 * Task: task-chat-006
 *
 * Shows running time, tool count, and mini activity timeline for a subagent.
 */

import { useState, useEffect } from "react"
import { cn } from "@/lib/utils"
import { Clock, Wrench } from "lucide-react"
import { formatToolName, getToolCategory } from "../tools/types"

export interface RecentTool {
  id: string
  toolName: string
  timestamp: number
}

export interface SubagentStatsProps {
  /** Subagent status */
  status: "running" | "completed"
  /** Start time timestamp */
  startTime: number
  /** Tool count */
  toolCount: number
  /** Recent tools for mini timeline */
  recentTools: RecentTool[]
  /** Optional class name */
  className?: string
}

/**
 * Displays subagent statistics with live updates.
 *
 * Features:
 * - Running time counter (updates while running)
 * - Tool count badge
 * - Mini activity timeline with gradient fade
 *
 * @example
 * ```tsx
 * <SubagentStats
 *   status="running"
 *   startTime={Date.now() - 5000}
 *   toolCount={3}
 *   recentTools={[...]}
 * />
 * ```
 */
export function SubagentStats({
  status,
  startTime,
  toolCount,
  recentTools,
  className,
}: SubagentStatsProps) {
  // Live running time counter
  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  useEffect(() => {
    // Calculate initial elapsed time
    setElapsedSeconds(Math.floor((Date.now() - startTime) / 1000))

    // Only update while running
    if (status !== "running") return

    const interval = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startTime) / 1000))
    }, 1000)

    return () => clearInterval(interval)
  }, [status, startTime])

  // Format elapsed time
  const formatElapsed = (seconds: number): string => {
    if (seconds < 60) return `${seconds}s`
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}m ${secs}s`
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {/* Stats row */}
      <div className="flex items-center gap-4 text-xs">
        {/* Running time */}
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Clock className="w-3 h-3" />
          <span
            className={cn(
              "font-mono",
              status === "running" && "text-exec-streaming"
            )}
          >
            {formatElapsed(elapsedSeconds)}
          </span>
        </div>

        {/* Tool count */}
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Wrench className="w-3 h-3" />
          <span className="font-medium">{toolCount}</span>
          <span>tool{toolCount !== 1 ? "s" : ""}</span>
        </div>
      </div>

      {/* Mini activity timeline */}
      {recentTools.length > 0 && (
        <div className="space-y-0.5">
          {recentTools.slice(0, 4).map((tool, index) => {
            const category = getToolCategory(tool.toolName)
            const displayName = formatToolName(tool.toolName)
            // Gradient fade: 100%, 70%, 50%, 30%
            const opacity = [1, 0.7, 0.5, 0.3][index] ?? 0.3

            return (
              <div
                key={`subagent-${tool.id}`}
                className="flex items-center gap-1.5 text-[10px]"
                style={{ opacity }}
              >
                <span
                  className={cn(
                    "w-1 h-1 rounded-full shrink-0",
                    category === "mcp" && "bg-tool-mcp",
                    category === "file" && "bg-tool-file",
                    category === "skill" && "bg-tool-skill",
                    category === "bash" && "bg-tool-bash",
                    category === "other" && "bg-muted-foreground"
                  )}
                />
                <span className="font-mono text-muted-foreground truncate">
                  {displayName}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default SubagentStats
