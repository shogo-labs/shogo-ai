/**
 * ToolCallDisplay Component
 * Task: task-2-4-002 (chat-presentational-components)
 *
 * Renders tool call information with 4 AI SDK states:
 * - input-streaming: Tool call being streamed, args not yet available
 * - input-available: Args available, tool executing
 * - output-available: Tool completed successfully with result
 * - output-error: Tool failed with error
 */

import * as React from "react"
import { cn } from "@/lib/utils"
import { Loader2, CheckCircle, XCircle, Terminal } from "lucide-react"

export type ToolCallState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error"

export interface ToolCallDisplayProps {
  toolName: string
  state: ToolCallState
  args?: Record<string, unknown>
  result?: unknown
  error?: string
}

export function ToolCallDisplay({
  toolName,
  state,
  args,
  result,
  error,
}: ToolCallDisplayProps) {
  const isStreaming = state === "input-streaming"
  const isExecuting = state === "input-available"
  const isSuccess = state === "output-available"
  const isError = state === "output-error"

  return (
    <div
      data-state={isError ? "error" : isSuccess ? "success" : "pending"}
      className={cn(
        "rounded-lg border p-3 text-sm font-mono",
        isError && "border-destructive bg-destructive/10 text-destructive",
        isSuccess && "border-green-500/50 bg-green-500/10",
        (isStreaming || isExecuting) && "border-border bg-muted"
      )}
    >
      {/* Header with tool name and status */}
      <div className="flex items-center gap-2 mb-2">
        <Terminal className="h-4 w-4 text-muted-foreground" />
        <span className="font-medium">{toolName}</span>

        {isStreaming && (
          <div
            data-testid="streaming-indicator"
            aria-busy="true"
            className="ml-auto flex items-center gap-1"
          >
            <span className="text-xs text-muted-foreground">Streaming</span>
            <div className="w-2 h-2 rounded-full bg-muted-foreground animate-pulse" />
          </div>
        )}

        {isExecuting && (
          <div
            data-testid="executing-indicator"
            className="ml-auto flex items-center gap-1"
          >
            <span className="text-xs text-muted-foreground">Executing</span>
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          </div>
        )}

        {isSuccess && (
          <CheckCircle
            data-testid="success-icon"
            className="ml-auto h-4 w-4 text-green-500"
          />
        )}

        {isError && (
          <XCircle className="ml-auto h-4 w-4 text-destructive" />
        )}
      </div>

      {/* Args display (not shown during input-streaming) */}
      {!isStreaming && args && Object.keys(args).length > 0 && (
        <div data-testid="tool-args" className="mb-2">
          <div className="text-xs text-muted-foreground mb-1">Arguments:</div>
          <pre className="text-xs bg-background/50 rounded p-2 overflow-x-auto">
            {JSON.stringify(args, null, 2)}
          </pre>
        </div>
      )}

      {/* Result display */}
      {isSuccess && result !== undefined && (
        <div data-testid="tool-result">
          <div className="text-xs text-muted-foreground mb-1">Result:</div>
          <pre className="text-xs bg-background/50 rounded p-2 overflow-x-auto">
            {typeof result === "string" ? result : JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}

      {/* Error display */}
      {isError && error && (
        <div data-testid="tool-error">
          <div className="text-xs text-destructive/80 mb-1">Error:</div>
          <div className="text-xs">{error}</div>
        </div>
      )}
    </div>
  )
}
