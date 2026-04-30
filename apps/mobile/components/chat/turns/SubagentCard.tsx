// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SubagentCard Component (React Native)
 *
 * Renders a compact card for agent_spawn / task tool calls.
 * Sub-agent content (text, tool calls, reasoning) is nested inside
 * the tool output via AI SDK preliminary tool results. The card
 * shows a summary of activity; pressing navigates to the Agents panel.
 */

import { useState, useEffect, useCallback, useMemo, useSyncExternalStore } from "react"
import { View, Text, Pressable } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { Bot, CheckCircle2, XCircle, ChevronRight, GitFork, Wrench, Square } from "lucide-react-native"
import { Motion } from "@legendapp/motion"
import { type ToolCallData, getToolKeyArg, formatToolName } from "../tools/types"
import { subagentStreamStore } from "../../../lib/subagent-stream-store"
import { stopSubagent } from "../../../lib/subagent-stop"
import { LiveBrowserView } from "../LiveBrowserView"
import { useChatContextSafe } from "../ChatContext"
import { useChatBridgeOptional } from "../../voice-mode/ChatBridgeContext"

export interface SubagentCardProps {
  tool: ToolCallData
  className?: string
  /**
   * Override the agent runtime base URL used for the live browser
   * preview. Defaults to the value resolved from `ChatContext` (when
   * mounted under `ChatPanel`) or the `ChatBridge` (when mounted under
   * the Shogo overlay). Tests / standalone surfaces can pass it
   * explicitly.
   */
  agentUrl?: string | null
}

const SPINNER_DURATION = 1200

function PulsingDot() {
  return (
    <Motion.View
      initial={{ opacity: 0.4, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{
        type: "timing",
        duration: SPINNER_DURATION,
        easing: "easeInOut",
        repeat: Infinity,
        repeatReverse: true,
      }}
      className="w-2 h-2 rounded-full bg-primary"
    />
  )
}

function getAgentLabel(tool: ToolCallData): string {
  const args = tool.args as Record<string, unknown> | undefined
  const desc = args?.description as string | undefined
  if (desc) return desc
  const subagentType = args?.subagent_type as string | undefined
  if (subagentType) return subagentType
  const agentType = args?.type as string | undefined
  if (agentType) return agentType
  return "Sub-agent"
}

function getAgentType(tool: ToolCallData): string {
  const args = tool.args as Record<string, unknown> | undefined
  return (args?.subagent_type as string | undefined)
    ?? (args?.type as string | undefined)
    ?? "task"
}

function isForkMode(tool: ToolCallData): boolean {
  const args = tool.args as Record<string, unknown> | undefined
  return tool.toolName === "agent_spawn" && !args?.type && !args?.subagent_type
}

interface SubagentOutputParts {
  parts: any[]
  toolCount: number
  lastText: string | null
}

function parseOutputParts(result: unknown): SubagentOutputParts {
  const r = result as Record<string, unknown> | undefined
  const parts = (r?.parts as any[]) ?? []
  let toolCount = 0
  let lastText: string | null = null
  for (const p of parts) {
    if (p?.type === "tool") toolCount++
    if (p?.type === "text" && p.text) lastText = p.text
  }
  return { parts, toolCount, lastText }
}

/**
 * Build a short, human-readable label for the latest activity inside a
 * subagent stream. Walks `parts` from the end and returns the first
 * useful tool-call summary or text snippet. Returns `null` when nothing
 * descriptive is available so callers can fall back to a generic
 * "Running..." line.
 */
function deriveLatestActivityLabel(parts: readonly any[] | undefined): string | null {
  if (!parts || parts.length === 0) return null
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    if (!part) continue
    if (part.type === "tool" && part.tool) {
      const tool = part.tool as ToolCallData
      const name = formatToolName(tool.toolName || "tool")
      const key = getToolKeyArg(tool.toolName, tool.args as Record<string, unknown> | undefined)
      const label = key ? `${name}: ${key}` : name
      return truncate(label, 80)
    }
    if (part.type === "text" && typeof part.text === "string") {
      const t = part.text.trim()
      if (t) return truncate(t.replace(/\s+/g, " "), 80)
    }
    if (part.type === "reasoning" && typeof part.text === "string") {
      const t = part.text.trim()
      if (t) return truncate(t.replace(/\s+/g, " "), 80)
    }
  }
  return null
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text
}

function getStatusText(tool: ToolCallData, elapsed: number, output: SubagentOutputParts): string {
  if (tool.state === "error") return tool.error ?? "Failed"

  if (tool.state === "success") {
    const r = tool.result as Record<string, unknown> | undefined
    const iters = r?.iterations as number | undefined
    const tc = r?.toolCalls as number | undefined ?? output.toolCount
    const parts: string[] = []
    if (tc > 0) parts.push(`${tc} tool${tc > 1 ? "s" : ""}`)
    if (iters && iters > 1) parts.push(`${iters} iterations`)
    return parts.length > 0 ? `Completed - ${parts.join(", ")}` : "Completed"
  }

  const suffix = output.toolCount > 0 ? ` - ${output.toolCount} tools` : ""
  const secs = Math.floor(elapsed / 1000)
  if (secs < 60) return `Running... ${secs}s${suffix}`
  const mins = Math.floor(secs / 60)
  const rem = secs % 60
  return `Running... ${mins}m ${rem}s${suffix}`
}

export function SubagentCard({ tool, className, agentUrl: agentUrlProp }: SubagentCardProps) {
  const [elapsed, setElapsed] = useState(0)
  const chatContext = useChatContextSafe()
  const bridge = useChatBridgeOptional()

  const isRunning = tool.state === "streaming"
  const isDone = tool.state === "success"
  const isError = tool.state === "error"

  useEffect(() => {
    if (!isRunning) return
    const start = Date.now()
    setElapsed(0)
    const interval = setInterval(() => {
      setElapsed(Date.now() - start)
    }, 1000)
    return () => clearInterval(interval)
  }, [isRunning])

  const handlePress = useCallback(() => {
    subagentStreamStore.requestTabSwitch(tool.id)
  }, [tool.id])

  const agentLabel = getAgentLabel(tool)
  const agentType = getAgentType(tool)
  const fork = isForkMode(tool)
  const output = useMemo(() => parseOutputParts(tool.result), [tool.result])
  const statusText = getStatusText(tool, elapsed, output)

  const Icon = fork ? GitFork : Bot

  // Subscribe to the stream store so the model badge / instance id that
  // arrive via preliminary tool output are picked up without a reload.
  useSyncExternalStore(
    subagentStreamStore.subscribe,
    () => subagentStreamStore.getVersion(),
    () => subagentStreamStore.getVersion(),
  )
  const streamData = subagentStreamStore.get(tool.id)
  const model = streamData?.model
  const instanceId = streamData?.instanceId

  const handleStop = useCallback((e: any) => {
    if (e?.stopPropagation) e.stopPropagation()
    if (!instanceId) return
    stopSubagent(instanceId, tool.id)
  }, [instanceId, tool.id])

  const latestActivity = useMemo(
    () => deriveLatestActivityLabel(streamData?.parts),
    [streamData?.parts],
  )

  const resolvedAgentUrl =
    agentUrlProp ?? chatContext?.agentUrl ?? bridge?.agentUrl ?? null
  const showLivePreview = isRunning && !!instanceId && !!resolvedAgentUrl

  return (
    <Pressable
      onPress={handlePress}
      className={cn(
        "overflow-hidden rounded-lg border border-border/40 bg-muted/20",
        className,
      )}
    >
      <View className="px-3 py-3 gap-2">
        {/* Top row: agent identity + status icon */}
        <View className="flex-row items-center gap-2">
          <Icon className="w-4 h-4 text-muted-foreground" size={16} />
          <Text
            className="flex-1 text-xs font-semibold text-foreground"
            numberOfLines={1}
          >
            {agentLabel}
          </Text>
          {model && (
            <Text className="text-[10px] text-muted-foreground font-mono px-1.5 py-0.5 rounded bg-muted/60" numberOfLines={1}>
              {model}
            </Text>
          )}
          <Text className="text-[10px] text-muted-foreground font-mono px-1.5 py-0.5 rounded bg-muted/60">
            {fork ? "fork" : agentType}
          </Text>
          {isRunning && instanceId && (
            <Pressable
              onPress={handleStop}
              accessibilityLabel="Stop subagent"
              testID={`stop-subagent-${instanceId}`}
              hitSlop={6}
              className="h-5 w-5 rounded-full bg-destructive items-center justify-center active:opacity-70"
            >
              <Square className="text-destructive-foreground m-auto" size={10} />
            </Pressable>
          )}
          {isRunning && !instanceId && <PulsingDot />}
          {isDone && <CheckCircle2 className="w-3.5 h-3.5 text-muted-foreground" size={14} />}
          {isError && <XCircle className="w-3.5 h-3.5 text-muted-foreground" size={14} />}
        </View>

        {/* Information row: latest activity (running) or status text. */}
        <View className="flex-row items-center gap-2">
          {isRunning && output.toolCount > 0 && (
            <Wrench className="w-3 h-3 text-muted-foreground/60" size={12} />
          )}
          <Text
            className="flex-1 text-[11px] text-muted-foreground"
            numberOfLines={1}
          >
            {isRunning && latestActivity ? latestActivity : statusText}
          </Text>
          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/50" size={14} />
        </View>

        {/* Live browser viewport — visible while the subagent is running
            and we have an AgentManager instance id to subscribe to. */}
        {showLivePreview && (
          <View className="mt-1">
            <LiveBrowserView
              instanceId={instanceId!}
              active={isRunning}
              agentUrl={resolvedAgentUrl}
            />
          </View>
        )}
      </View>
    </Pressable>
  )
}

export default SubagentCard
