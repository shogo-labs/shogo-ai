/**
 * ToolCallDetail Component
 * Task: task-chat-005
 *
 * Individual tool call detail component for timeline display.
 * Shows tool name with namespace styling, execution state, args preview.
 */

import { cn } from "@/lib/utils"
import { CheckCircle2, XCircle, Loader2 } from "lucide-react"
import { type ToolCallData, formatToolName, getToolNamespace } from "./types"

export interface ToolCallDetailProps {
  /** Tool call data to display */
  tool: ToolCallData
  /** Opacity for gradient fade (0-1) */
  opacity?: number
  /** Optional class name */
  className?: string
}

/**
 * Renders detailed view of a single tool call.
 *
 * Features:
 * - Tool name with namespace styling (JetBrains Mono)
 * - Execution state icon (streaming/success/error)
 * - Args preview (truncated)
 * - Result or error display
 * - Category color indicator
 *
 * @example
 * ```tsx
 * <ToolCallDetail tool={toolCall} opacity={0.85} />
 * ```
 */
export function ToolCallDetail({ tool, opacity = 1, className }: ToolCallDetailProps) {
  const displayName = formatToolName(tool.toolName)
  const namespace = getToolNamespace(tool.toolName)

  // State icon based on execution state
  const StateIcon = {
    streaming: Loader2,
    success: CheckCircle2,
    error: XCircle,
  }[tool.state]

  // Truncate args preview
  const argsPreview = tool.args
    ? JSON.stringify(tool.args).slice(0, 60) + (JSON.stringify(tool.args).length > 60 ? "..." : "")
    : null

  return (
    <div
      className={cn(
        "flex items-start gap-2 py-1.5 px-2 rounded-md transition-colors",
        "hover:bg-muted/50",
        className
      )}
      style={{ opacity }}
    >
      {/* Category color indicator */}
      <span
        className={cn(
          "w-1.5 h-1.5 rounded-full shrink-0 mt-1.5",
          tool.category === "mcp" && "bg-tool-mcp",
          tool.category === "file" && "bg-tool-file",
          tool.category === "skill" && "bg-tool-skill",
          tool.category === "bash" && "bg-tool-bash",
          tool.category === "other" && "bg-muted-foreground"
        )}
      />

      {/* Tool info */}
      <div className="flex-1 min-w-0">
        {/* Tool name with namespace */}
        <div className="flex items-center gap-1.5">
          <span
            className="font-mono text-xs font-medium truncate"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {namespace && (
              <span className="text-muted-foreground">{namespace}.</span>
            )}
            <span className="text-foreground">{displayName.replace(`${namespace}.`, "")}</span>
          </span>

          {/* Duration badge */}
          {tool.duration !== undefined && (
            <span className="text-[10px] text-muted-foreground">
              {tool.duration}ms
            </span>
          )}
        </div>

        {/* Args preview */}
        {argsPreview && (
          <div
            className="text-[10px] text-muted-foreground/70 truncate mt-0.5 font-mono"
            title={JSON.stringify(tool.args, null, 2)}
          >
            {argsPreview}
          </div>
        )}

        {/* Error message */}
        {tool.error && (
          <div className="text-[10px] text-exec-error mt-0.5 truncate">
            {tool.error}
          </div>
        )}
      </div>

      {/* State icon */}
      <StateIcon
        className={cn(
          "w-3.5 h-3.5 shrink-0",
          tool.state === "streaming" && "text-exec-streaming animate-spin",
          tool.state === "success" && "text-exec-success",
          tool.state === "error" && "text-exec-error"
        )}
      />
    </div>
  )
}

export default ToolCallDetail
