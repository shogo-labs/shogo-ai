/**
 * ToolCallDisplay Component
 * Task: task-2-4-002 (chat-presentational-components)
 * Task: task-cpbi-010 (tool-call-collapsible-display)
 * Task: task-cpbi-011 (result-truncation-strategy)
 *
 * Renders tool call information with 4 AI SDK states:
 * - input-streaming: Tool call being streamed, args not yet available
 * - input-available: Args available, tool executing
 * - output-available: Tool completed successfully with result
 * - output-error: Tool failed with error
 *
 * Collapsible behavior (task-cpbi-010):
 * - Default: collapsed, showing summary line
 * - Expanded: shows full args and result with syntax highlighting
 * - Click header to toggle
 * - State is component-local (resets on navigation)
 *
 * Truncation behavior (task-cpbi-011):
 * - Results > 500 characters show truncated preview with 'Show more' toggle
 * - Deeply nested objects (>2 levels) are collapsed to {...}
 * - Metadata (ok, count, schema) always visible regardless of truncation
 */

import { useState, useMemo } from "react"
import { cn } from "@/lib/utils"
import { Loader2, CheckCircle, XCircle, Terminal, Database, FileJson2, Eye, Bot, ChevronRight, ChevronDown, type LucideIcon } from "lucide-react"

/**
 * Truncation constants and types (task-cpbi-011)
 */
const TRUNCATION_THRESHOLD = 500
const MAX_DEPTH = 2

interface TruncationResult {
  displayContent: string
  isTruncated: boolean
  hiddenCount: number
}

/**
 * Truncates content if it exceeds the threshold
 */
function truncateContent(content: string, threshold = TRUNCATION_THRESHOLD): TruncationResult {
  if (content.length <= threshold) {
    return { displayContent: content, isTruncated: false, hiddenCount: 0 }
  }
  return {
    displayContent: content.slice(0, threshold),
    isTruncated: true,
    hiddenCount: content.length - threshold,
  }
}

/**
 * Stringifies an object with depth limiting - objects deeper than maxDepth
 * are replaced with {...} for objects and [Array(n)] for arrays
 */
function stringifyWithDepthLimit(obj: unknown, maxDepth = MAX_DEPTH): string {
  function limitDepth(value: unknown, currentDepth: number): unknown {
    if (value === null || typeof value !== "object") {
      return value
    }

    if (currentDepth >= maxDepth) {
      if (Array.isArray(value)) {
        return `[Array(${value.length})]`
      }
      return "{...}"
    }

    if (Array.isArray(value)) {
      return value.map((item) => limitDepth(item, currentDepth + 1))
    }

    const result: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = limitDepth(val, currentDepth + 1)
    }
    return result
  }

  const limited = limitDepth(obj, 0)
  return JSON.stringify(limited, null, 2)
}

/**
 * Extracts key metadata fields from a result object that should always be visible
 */
function extractMetadata(result: unknown): Record<string, unknown> {
  if (typeof result !== "object" || result === null) {
    return {}
  }

  const r = result as Record<string, unknown>
  const metadata: Record<string, unknown> = {}

  if ("ok" in r) metadata.ok = r.ok
  if ("success" in r) metadata.success = r.success
  if ("count" in r) metadata.count = r.count
  if ("schemaName" in r) metadata.schema = r.schemaName
  if ("schema" in r && typeof r.schema === "string") metadata.schema = r.schema

  return metadata
}

/**
 * Namespace-to-icon mapping for tool calls
 * Task: task-cpbi-009 (tool-specific-icons)
 */
const NAMESPACE_ICONS: Record<string, LucideIcon> = {
  store: Database,
  schema: FileJson2,
  view: Eye,
  agent: Bot,
}

/**
 * Returns the appropriate Lucide icon for a tool based on its namespace prefix.
 * @param toolName - Full tool name (e.g., "store.create", "schema.set")
 * @returns LucideIcon component for the namespace, or Terminal for unknown namespaces
 */
export function getToolIcon(toolName: string): LucideIcon {
  const namespace = toolName.split(".")[0]
  return NAMESPACE_ICONS[namespace] ?? Terminal
}

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
  /** Concise metadata string for collapsed view (from ToolCallLog.summaryLine) */
  summaryLine?: string
}

export function ToolCallDisplay({
  toolName,
  state,
  args,
  result,
  error,
  summaryLine,
}: ToolCallDisplayProps) {
  const [isCollapsed, setIsCollapsed] = useState(true)
  const [showFullResult, setShowFullResult] = useState(false)

  const isStreaming = state === "input-streaming"
  const isExecuting = state === "input-available"
  const isSuccess = state === "output-available"
  const isError = state === "output-error"

  const Icon = getToolIcon(toolName)
  const ChevronIcon = isCollapsed ? ChevronRight : ChevronDown

  // Memoize result processing (task-cpbi-011)
  const { resultString, truncated, metadata, hasMetadata } = useMemo(() => {
    if (result === undefined) {
      return { resultString: "", truncated: null, metadata: {}, hasMetadata: false }
    }

    const resString =
      typeof result === "string" ? result : stringifyWithDepthLimit(result)
    const truncatedResult = truncateContent(resString)
    const extractedMetadata = extractMetadata(result)
    const hasMeta = Object.keys(extractedMetadata).length > 0

    return {
      resultString: resString,
      truncated: truncatedResult,
      metadata: extractedMetadata,
      hasMetadata: hasMeta,
    }
  }, [result])

  return (
    <div
      data-state={isError ? "error" : isSuccess ? "success" : "pending"}
      className={cn(
        "rounded-md border p-2 text-xs font-mono",
        isError && "border-destructive bg-destructive/10 text-destructive",
        isSuccess && "border-green-500/50 bg-green-500/10",
        (isStreaming || isExecuting) && "border-border bg-muted"
      )}
    >
      {/* Clickable header with tool name and status */}
      <button
        onClick={() => setIsCollapsed(!isCollapsed)}
        data-testid="tool-call-header"
        className="flex items-center gap-1.5 w-full text-left"
      >
        <ChevronIcon className="h-3 w-3 text-muted-foreground shrink-0" />
        <Icon className="h-3 w-3 text-muted-foreground shrink-0" />
        <span className="font-medium text-[10px]">{toolName}</span>

        {/* Summary line in collapsed mode */}
        {isCollapsed && summaryLine && (
          <span
            data-testid="summary-line"
            className="text-muted-foreground text-[9px] ml-1 truncate flex-1"
          >
            {summaryLine}
          </span>
        )}

        {isStreaming && (
          <div
            data-testid="streaming-indicator"
            aria-busy="true"
            className="ml-auto flex items-center gap-1 shrink-0"
          >
            <span className="text-[9px] text-muted-foreground">Streaming</span>
            <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-pulse" />
          </div>
        )}

        {isExecuting && (
          <div
            data-testid="executing-indicator"
            className="ml-auto flex items-center gap-1 shrink-0"
          >
            <span className="text-[9px] text-muted-foreground">Executing</span>
            <Loader2 className="h-2.5 w-2.5 animate-spin text-muted-foreground" />
          </div>
        )}

        {isSuccess && (
          <CheckCircle
            data-testid="success-icon"
            className="ml-auto h-3 w-3 text-green-500 shrink-0"
          />
        )}

        {isError && (
          <XCircle className="ml-auto h-3 w-3 text-destructive shrink-0" />
        )}
      </button>

      {/* Expandable content - only shown when not collapsed */}
      {!isCollapsed && (
        <>
          {/* Args display (not shown during input-streaming) */}
          {!isStreaming && args && Object.keys(args).length > 0 && (
            <div data-testid="tool-args" className="mt-1.5">
              <div className="text-[9px] text-muted-foreground mb-0.5 uppercase">Args</div>
              <pre className="text-[10px] bg-background/50 rounded p-1.5 overflow-x-auto max-h-32 overflow-y-auto">
                {JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}

          {/* Result display with truncation (task-cpbi-011) */}
          {isSuccess && result !== undefined && truncated && (
            <div data-testid="tool-result" className="mt-1.5">
              <div className="text-[9px] text-muted-foreground mb-0.5 uppercase">Result</div>

              {/* Metadata section - always visible (task-cpbi-011) */}
              {hasMetadata && (
                <div
                  data-testid="result-metadata"
                  className="text-[9px] bg-background/50 rounded p-1.5 mb-1.5 flex flex-wrap gap-x-3 gap-y-0.5"
                >
                  {Object.entries(metadata).map(([key, value]) => (
                    <span key={key}>
                      <span className="text-muted-foreground">{key}:</span>{" "}
                      <span className="font-medium">{String(value)}</span>
                    </span>
                  ))}
                </div>
              )}

              {/* Truncated/full result content */}
              <pre className="text-[10px] bg-background/50 rounded p-1.5 overflow-x-auto whitespace-pre-wrap max-h-32 overflow-y-auto">
                {showFullResult ? resultString : truncated.displayContent}
              </pre>

              {/* Show more/less toggle for truncated content */}
              {truncated.isTruncated && (
                <button
                  onClick={() => setShowFullResult(!showFullResult)}
                  className="text-[9px] text-muted-foreground hover:underline mt-0.5"
                  data-testid="show-more-toggle"
                >
                  {showFullResult
                    ? "Show less"
                    : `Show more (~${truncated.hiddenCount} chars)`}
                </button>
              )}
            </div>
          )}
        </>
      )}

      {/* Error display - always visible regardless of collapsed state */}
      {isError && error && (
        <div data-testid="tool-error" className="mt-1.5">
          <div className="text-[9px] text-destructive/80 mb-0.5 uppercase">Error</div>
          <div className="text-[10px]">{error}</div>
        </div>
      )}
    </div>
  )
}
