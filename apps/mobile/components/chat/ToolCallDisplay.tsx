/**
 * ToolCallDisplay Component (React Native)
 *
 * Renders tool call information with 4 AI SDK states:
 * - input-streaming: Tool call being streamed, args not yet available
 * - input-available: Args available, tool executing
 * - output-available: Tool completed successfully with result
 * - output-error: Tool failed with error
 *
 * Collapsible with summary line in collapsed state.
 * Truncation for large results.
 */

import { useState, useMemo } from "react"
import { View, Text, Pressable, ScrollView } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import {
  Loader2,
  CheckCircle,
  XCircle,
  Terminal,
  Database,
  FileJson2,
  Eye,
  Bot,
  ChevronRight,
  ChevronDown,
  type LucideIcon,
} from "lucide-react-native"

const TRUNCATION_THRESHOLD = 500
const MAX_DEPTH = 2

interface TruncationResult {
  displayContent: string
  isTruncated: boolean
  hiddenCount: number
}

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

const NAMESPACE_ICONS: Record<string, LucideIcon> = {
  store: Database,
  schema: FileJson2,
  view: Eye,
  agent: Bot,
}

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
    <View
      className={cn(
        "rounded-md border p-2",
        isError && "border-red-500 bg-red-500/10",
        isSuccess && "border-green-500/50 bg-green-500/10",
        (isStreaming || isExecuting) && "border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-800"
      )}
    >
      {/* Clickable header */}
      <Pressable
        onPress={() => setIsCollapsed(!isCollapsed)}
        className="flex-row items-center gap-1.5 w-full"
      >
        <ChevronIcon className="h-3 w-3 text-gray-400 shrink-0" size={12} />
        <Icon className="h-3 w-3 text-gray-400 shrink-0" size={12} />
        <Text className="font-medium text-[10px] font-mono text-foreground">{toolName}</Text>

        {isCollapsed && summaryLine && (
          <Text
            className="text-gray-400 text-[9px] ml-1 flex-1"
            numberOfLines={1}
          >
            {summaryLine}
          </Text>
        )}

        {isStreaming && (
          <View className="ml-auto flex-row items-center gap-1 shrink-0">
            <Text className="text-[9px] text-gray-400">Streaming</Text>
            <View className="w-1.5 h-1.5 rounded-full bg-gray-400" />
          </View>
        )}

        {isExecuting && (
          <View className="ml-auto flex-row items-center gap-1 shrink-0">
            <Text className="text-[9px] text-gray-400">Executing</Text>
            <Loader2 className="h-2.5 w-2.5 text-gray-400" size={10} />
          </View>
        )}

        {isSuccess && (
          <CheckCircle className="ml-auto h-3 w-3 text-green-500 shrink-0" size={12} />
        )}

        {isError && (
          <XCircle className="ml-auto h-3 w-3 text-red-500 shrink-0" size={12} />
        )}
      </Pressable>

      {/* Expandable content */}
      {!isCollapsed && (
        <>
          {!isStreaming && args && Object.keys(args).length > 0 && (
            <View className="mt-1.5">
              <Text className="text-[9px] text-gray-400 mb-0.5 uppercase">Args</Text>
              <ScrollView
                nestedScrollEnabled
                className="bg-black/5 dark:bg-white/5 rounded p-1.5 max-h-32"
              >
                <Text className="text-[10px] font-mono text-foreground" selectable>
                  {JSON.stringify(args, null, 2)}
                </Text>
              </ScrollView>
            </View>
          )}

          {isSuccess && result !== undefined && truncated && (
            <View className="mt-1.5">
              <Text className="text-[9px] text-gray-400 mb-0.5 uppercase">Result</Text>

              {hasMetadata && (
                <View className="bg-black/5 dark:bg-white/5 rounded p-1.5 mb-1.5 flex-row flex-wrap gap-x-3 gap-y-0.5">
                  {Object.entries(metadata).map(([key, value]) => (
                    <Text key={key} className="text-[9px] text-foreground">
                      <Text className="text-gray-400">{key}:</Text>{" "}
                      <Text className="font-medium">{String(value)}</Text>
                    </Text>
                  ))}
                </View>
              )}

              <ScrollView nestedScrollEnabled className="bg-black/5 dark:bg-white/5 rounded p-1.5 max-h-32">
                <Text className="text-[10px] font-mono text-foreground" selectable>
                  {showFullResult ? resultString : truncated.displayContent}
                </Text>
              </ScrollView>

              {truncated.isTruncated && (
                <Pressable onPress={() => setShowFullResult(!showFullResult)}>
                  <Text className="text-[9px] text-gray-400 mt-0.5">
                    {showFullResult
                      ? "Show less"
                      : `Show more (~${truncated.hiddenCount} chars)`}
                  </Text>
                </Pressable>
              )}
            </View>
          )}
        </>
      )}

      {/* Error display - always visible */}
      {isError && error && (
        <View className="mt-1.5">
          <Text className="text-[9px] text-red-400/80 mb-0.5 uppercase">Error</Text>
          <Text className="text-[10px] text-red-500">{error}</Text>
        </View>
      )}
    </View>
  )
}
