/**
 * ToolCallPart - Display component for AI SDK tool call states
 *
 * Handles the 4 tool invocation states from AI SDK 4.2+:
 * - input-streaming: Tool is receiving input arguments
 * - input-available: Tool input complete, about to execute
 * - output-available: Tool execution complete with result
 * - output-error: Tool execution failed with error
 */

import { cn } from "@/lib/utils"

export type ToolCallState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error"

interface ToolCallPartProps {
  toolName: string
  state: ToolCallState
  args?: Record<string, unknown>
  result?: unknown
  error?: string
}

export function ToolCallPart({
  toolName,
  state,
  args,
  result,
  error,
}: ToolCallPartProps) {
  const getStateIndicator = () => {
    switch (state) {
      case "input-streaming":
        return {
          icon: "⏳",
          label: "Streaming input...",
          color: "text-yellow-400",
          bg: "bg-yellow-400/10",
        }
      case "input-available":
        return {
          icon: "▶",
          label: "Executing...",
          color: "text-blue-400",
          bg: "bg-blue-400/10",
        }
      case "output-available":
        return {
          icon: "✓",
          label: "Complete",
          color: "text-green-400",
          bg: "bg-green-400/10",
        }
      case "output-error":
        return {
          icon: "✗",
          label: "Error",
          color: "text-red-400",
          bg: "bg-red-400/10",
        }
    }
  }

  const indicator = getStateIndicator()

  // Format tool name for display (e.g., "store.create" -> "Store Create")
  const formatToolName = (name: string) => {
    return name
      .split(/[._]/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  }

  return (
    <div
      className={cn(
        "rounded-md border border-border overflow-hidden my-2",
        indicator.bg
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-card/50 border-b border-border">
        <span className={cn("text-lg", indicator.color)}>{indicator.icon}</span>
        <span className="font-mono text-sm font-medium">
          {formatToolName(toolName)}
        </span>
        <span className={cn("text-xs ml-auto", indicator.color)}>
          {indicator.label}
        </span>
      </div>

      {/* Arguments */}
      {args && Object.keys(args).length > 0 && (
        <div className="px-3 py-2 border-b border-border">
          <div className="text-xs text-muted-foreground mb-1">Arguments:</div>
          <pre className="text-xs font-mono bg-background/50 p-2 rounded overflow-x-auto max-h-32">
            {JSON.stringify(args, null, 2)}
          </pre>
        </div>
      )}

      {/* Result */}
      {state === "output-available" && result !== undefined && (
        <div className="px-3 py-2">
          <div className="text-xs text-muted-foreground mb-1">Result:</div>
          <pre className="text-xs font-mono bg-background/50 p-2 rounded overflow-x-auto max-h-32">
            {typeof result === "string"
              ? result
              : JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}

      {/* Error */}
      {state === "output-error" && error && (
        <div className="px-3 py-2">
          <div className="text-xs text-red-400 mb-1">Error:</div>
          <pre className="text-xs font-mono bg-red-400/10 p-2 rounded text-red-300">
            {error}
          </pre>
        </div>
      )}
    </div>
  )
}
