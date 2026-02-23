/**
 * ToolCallGroup Component
 *
 * Collapsible card that groups consecutive tool calls with the same name.
 * Collapsed by default, shows tool name + count + status summary.
 * Expands to reveal individual InlineToolWidget instances.
 */

import { cn } from "@/lib/utils"
import {
  CheckCircle2,
  XCircle,
  Loader2,
  ChevronRight,
  ChevronDown,
} from "lucide-react"
import {
  type ToolCallData,
  formatToolName,
  getToolNamespace,
} from "../tools/types"
import { InlineToolWidget } from "./InlineToolWidget"

export interface ToolCallGroupProps {
  toolName: string
  tools: Array<{ tool: ToolCallData; id: string }>
  isExpanded?: boolean
  onToggle?: () => void
  className?: string
}

export function ToolCallGroup({
  toolName,
  tools,
  isExpanded = false,
  onToggle,
  className,
}: ToolCallGroupProps) {
  const displayName = formatToolName(toolName)
  const namespace = getToolNamespace(toolName)
  const category = tools[0]?.tool.category || "other"

  const hasErrors = tools.some((t) => t.tool.state === "error")
  const allSuccess =
    !hasErrors && tools.every((t) => t.tool.state === "success")
  const hasStreaming = tools.some((t) => t.tool.state === "streaming")

  return (
    <div
      className={cn(
        "rounded-md border overflow-hidden transition-colors duration-150",
        hasErrors
          ? "border-exec-error/30 bg-exec-error/2"
          : "border-border/40 bg-muted/3",
        className,
      )}
    >
      {/* Header row */}
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "w-full flex items-center gap-1.5 py-1.5 px-2",
          "hover:bg-muted/50 transition-colors",
          "text-left",
        )}
      >
        {isExpanded ? (
          <ChevronDown className="w-2.5 h-2.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="w-2.5 h-2.5 text-muted-foreground shrink-0" />
        )}

        {/* Category dot */}
        <span
          className={cn(
            "w-1 h-1 rounded-full shrink-0",
            category === "mcp" && "bg-tool-mcp",
            category === "file" && "bg-tool-file",
            category === "skill" && "bg-tool-skill",
            category === "bash" && "bg-tool-bash",
            category === "other" && "bg-muted-foreground",
          )}
        />

        {/* Tool name */}
        <span
          className="font-mono text-[10px] font-medium shrink-0"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {namespace && (
            <span className="text-muted-foreground">{namespace}.</span>
          )}
          <span className="text-foreground">
            {displayName.replace(`${namespace}.`, "")}
          </span>
        </span>

        {/* Count badge */}
        <span className="text-[9px] text-muted-foreground bg-muted/80 rounded-full px-1.5 py-px font-medium tabular-nums shrink-0">
          &times;{tools.length}
        </span>

        <span className="flex-1" />

        {/* Single summarized status icon */}
        {hasStreaming ? (
          <Loader2 className="w-3 h-3 text-exec-streaming animate-spin shrink-0" />
        ) : hasErrors ? (
          <XCircle className="w-3 h-3 text-exec-error shrink-0" />
        ) : allSuccess ? (
          <CheckCircle2 className="w-3 h-3 text-exec-success shrink-0" />
        ) : null}
      </button>

      {/* Expanded: individual tools */}
      {isExpanded && (
        <div className="border-t border-border/30">
          {tools.map((t) => (
            <InlineToolWidget key={t.id} tool={t.tool} />
          ))}
        </div>
      )}
    </div>
  )
}

export default ToolCallGroup
