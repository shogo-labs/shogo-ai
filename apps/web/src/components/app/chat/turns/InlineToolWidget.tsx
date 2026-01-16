/**
 * InlineToolWidget Component
 * Task: feat-chat-tool-interleaving
 *
 * Compact inline tool display with expand/collapse for interleaved rendering.
 * Shows tool name, key argument, and state in collapsed view.
 * Expands to show full args and result.
 */

import { useState } from "react"
import { cn } from "@/lib/utils"
import { CheckCircle2, XCircle, Loader2, ChevronRight, ChevronDown } from "lucide-react"
import {
  type ToolCallData,
  formatToolName,
  getToolNamespace,
  getToolKeyArg,
} from "../tools/types"

export interface InlineToolWidgetProps {
  /** Tool call data to display */
  tool: ToolCallData
  /** Whether the tool details are expanded */
  isExpanded?: boolean
  /** Callback when expand/collapse is toggled */
  onToggle?: () => void
  /** Optional class name */
  className?: string
}

/**
 * Renders an inline tool call widget with expand/collapse.
 *
 * Collapsed: [●] wavesmith.store_query  schema.Model  ✓
 * Expanded: Shows full args and result below the header
 *
 * @example
 * ```tsx
 * <InlineToolWidget
 *   tool={toolCall}
 *   isExpanded={expandedTools.has(toolCall.id)}
 *   onToggle={() => toggleExpanded(toolCall.id)}
 * />
 * ```
 */
export function InlineToolWidget({
  tool,
  isExpanded: controlledExpanded,
  onToggle,
  className,
}: InlineToolWidgetProps) {
  // Support both controlled and uncontrolled modes
  const [internalExpanded, setInternalExpanded] = useState(false)
  const isExpanded = controlledExpanded ?? internalExpanded

  const handleToggle = () => {
    if (onToggle) {
      onToggle()
    } else {
      setInternalExpanded(!internalExpanded)
    }
  }

  const displayName = formatToolName(tool.toolName)
  const namespace = getToolNamespace(tool.toolName)
  const keyArg = getToolKeyArg(tool.toolName, tool.args)

  // State icon based on execution state
  const StateIcon = {
    streaming: Loader2,
    success: CheckCircle2,
    error: XCircle,
  }[tool.state]

  // Format args/result for display
  const formatJson = (data: unknown): string => {
    try {
      return JSON.stringify(data, null, 2)
    } catch {
      return String(data)
    }
  }

  return (
    <div
      className={cn(
        "rounded-md border border-border/50 bg-muted/30 overflow-hidden",
        "transition-all duration-200",
        className
      )}
    >
      {/* Collapsed header - always visible */}
      <button
        type="button"
        onClick={handleToggle}
        className={cn(
          "w-full flex items-center gap-2 py-1.5 px-2.5",
          "hover:bg-muted/50 transition-colors",
          "text-left"
        )}
      >
        {/* Expand/collapse chevron */}
        {isExpanded ? (
          <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
        )}

        {/* Category color indicator */}
        <span
          className={cn(
            "w-1.5 h-1.5 rounded-full shrink-0",
            tool.category === "mcp" && "bg-tool-mcp",
            tool.category === "file" && "bg-tool-file",
            tool.category === "skill" && "bg-tool-skill",
            tool.category === "bash" && "bg-tool-bash",
            tool.category === "other" && "bg-muted-foreground"
          )}
        />

        {/* Tool name */}
        <span
          className="font-mono text-xs font-medium shrink-0"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {namespace && (
            <span className="text-muted-foreground">{namespace}.</span>
          )}
          <span className="text-foreground">
            {displayName.replace(`${namespace}.`, "")}
          </span>
        </span>

        {/* Key argument - right aligned, muted */}
        {keyArg && (
          <span className="flex-1 text-[10px] text-muted-foreground/60 font-light truncate text-right font-mono">
            {keyArg}
          </span>
        )}

        {/* Spacer when no key arg */}
        {!keyArg && <span className="flex-1" />}

        {/* State icon */}
        <StateIcon
          className={cn(
            "w-3.5 h-3.5 shrink-0",
            tool.state === "streaming" && "text-exec-streaming animate-spin",
            tool.state === "success" && "text-exec-success",
            tool.state === "error" && "text-exec-error"
          )}
        />
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div className="border-t border-border/50 p-2.5 space-y-2">
          {/* Arguments */}
          {tool.args && Object.keys(tool.args).length > 0 && (
            <div className="space-y-1">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                Arguments
              </span>
              <pre className="text-[11px] font-mono bg-background/50 rounded p-2 overflow-x-auto max-h-40 overflow-y-auto">
                {formatJson(tool.args)}
              </pre>
            </div>
          )}

          {/* Result */}
          {tool.state === "success" && tool.result !== undefined && (
            <div className="space-y-1">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                Result
              </span>
              <pre className="text-[11px] font-mono bg-background/50 rounded p-2 overflow-x-auto max-h-40 overflow-y-auto">
                {formatJson(tool.result)}
              </pre>
            </div>
          )}

          {/* Error */}
          {tool.state === "error" && tool.error && (
            <div className="space-y-1">
              <span className="text-[10px] font-medium text-exec-error uppercase tracking-wide">
                Error
              </span>
              <pre className="text-[11px] font-mono bg-exec-error/10 text-exec-error rounded p-2 overflow-x-auto">
                {tool.error}
              </pre>
            </div>
          )}

          {/* Duration */}
          {tool.duration !== undefined && tool.duration > 0 && (
            <div className="text-[10px] text-muted-foreground">
              Duration: {tool.duration < 1000 ? `${tool.duration}ms` : `${(tool.duration / 1000).toFixed(2)}s`}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default InlineToolWidget
