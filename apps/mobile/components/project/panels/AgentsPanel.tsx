// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useMemo, useSyncExternalStore, useState } from "react"
import { View, Text, ScrollView, Pressable } from "react-native"
import {
  Bot,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronRight,
  Wrench,
  Zap,
} from "lucide-react-native"
import { Motion } from "@legendapp/motion"
import { subagentStreamStore, type SubagentStreamData } from "../../../lib/subagent-stream-store"
import { MarkdownText } from "../../chat/MarkdownText"
import { ThinkingWidget } from "../../chat/turns/ThinkingWidget"
import { InlineToolWidget } from "../../chat/turns/InlineToolWidget"

interface AgentsPanelProps {
  visible: boolean
  selectedToolId?: string | null
}

const PULSE_DURATION = 1200

function PulsingDot() {
  return (
    <Motion.View
      initial={{ opacity: 0.4, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{
        type: "timing",
        duration: PULSE_DURATION,
        easing: "easeInOut",
        repeat: Infinity,
        repeatReverse: true,
      }}
      className="w-2 h-2 rounded-full bg-primary"
    />
  )
}

function AgentEntry({
  toolId,
  data,
  isExpanded,
  onToggle,
}: {
  toolId: string
  data: SubagentStreamData
  isExpanded: boolean
  onToggle: () => void
}) {
  const isRunning = data.status === "running"
  const isDone = data.status === "completed"
  const isError = data.status === "error"

  const label = data.description || data.agentType || "Sub-agent"

  return (
    <View className="rounded-lg border border-border/40 bg-muted/20 overflow-hidden">
      {/* Header row — always visible */}
      <Pressable onPress={onToggle} className="px-3 py-3 flex-row items-center gap-2">
        <Bot className="text-muted-foreground" size={16} />
        <Text className="flex-1 text-xs font-semibold text-foreground" numberOfLines={1}>
          {label}
        </Text>
        <Text className="text-[10px] text-muted-foreground font-mono px-1.5 py-0.5 rounded bg-muted/60">
          {data.agentType}
        </Text>
        {isRunning && <PulsingDot />}
        {isDone && <CheckCircle2 className="text-muted-foreground" size={14} />}
        {isError && <XCircle className="text-muted-foreground" size={14} />}
        {isExpanded ? (
          <ChevronDown className="text-muted-foreground/50" size={14} />
        ) : (
          <ChevronRight className="text-muted-foreground/50" size={14} />
        )}
      </Pressable>

      {/* Expandable stream body */}
      {isExpanded && (
        <View className="px-3 pb-3 gap-2 border-t border-border/30">
          {/* Summary line when done */}
          {data.summary && (
            <View className="pt-2">
              <Text className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">
                Summary
              </Text>
              <View className="rounded-md border border-border/30 bg-muted/20 p-2">
                <MarkdownText className="text-foreground text-xs prose-sm">
                  {data.summary}
                </MarkdownText>
              </View>
            </View>
          )}

          {/* Stats */}
          {data.parts.length > 0 && (
            <View className="flex-row items-center gap-4 pt-1">
              {(() => {
                const toolCount = data.parts.filter((p) => p.type === "tool").length
                return toolCount > 0 ? (
                  <View className="flex-row items-center gap-1.5">
                    <Wrench className="text-muted-foreground" size={12} />
                    <Text className="text-xs text-muted-foreground">
                      {toolCount} tool{toolCount !== 1 ? "s" : ""}
                    </Text>
                  </View>
                ) : null
              })()}
              {(() => {
                const reasoningCount = data.parts.filter((p) => p.type === "reasoning").length
                return reasoningCount > 0 ? (
                  <View className="flex-row items-center gap-1.5">
                    <Zap className="text-muted-foreground" size={12} />
                    <Text className="text-xs text-muted-foreground">
                      {reasoningCount} step{reasoningCount !== 1 ? "s" : ""}
                    </Text>
                  </View>
                ) : null
              })()}
            </View>
          )}

          {/* Stream parts */}
          {data.parts.length > 0 ? (
            <View className="gap-2 pt-1">
              {data.parts.map((part) => {
                if (part.type === "text") {
                  return (
                    <View key={part.id}>
                      <MarkdownText className="text-foreground text-xs prose-sm">
                        {part.text}
                      </MarkdownText>
                    </View>
                  )
                }
                if (part.type === "reasoning") {
                  return (
                    <ThinkingWidget
                      key={part.id}
                      text={part.text}
                      isStreaming={part.isStreaming}
                      durationSeconds={part.durationSeconds}
                    />
                  )
                }
                if (part.type === "tool") {
                  return <InlineToolWidget key={part.id} tool={part.tool} />
                }
                return null
              })}
            </View>
          ) : isRunning ? (
            <View className="items-center justify-center py-4 gap-2">
              <View className="flex-row items-center gap-1.5">
                <View className="w-1.5 h-1.5 rounded-full bg-muted-foreground opacity-50" />
                <View className="w-1.5 h-1.5 rounded-full bg-muted-foreground opacity-50" />
                <View className="w-1.5 h-1.5 rounded-full bg-muted-foreground opacity-50" />
              </View>
              <Text className="text-xs text-muted-foreground">Working...</Text>
            </View>
          ) : null}
        </View>
      )}
    </View>
  )
}

export function AgentsPanel({ visible, selectedToolId }: AgentsPanelProps) {
  const storeVersion = useSyncExternalStore(
    subagentStreamStore.subscribe,
    () => subagentStreamStore.getVersion(),
    () => subagentStreamStore.getVersion(),
  )

  const entries = useMemo(() => {
    const result: { toolId: string; data: SubagentStreamData }[] = []
    for (const [toolId, data] of subagentStreamStore.getAll()) {
      result.push({ toolId, data })
    }
    return result
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeVersion])

  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

  // Auto-expand the selected agent when navigated from SubagentCard
  useMemo(() => {
    if (selectedToolId && !expandedIds.has(selectedToolId)) {
      setExpandedIds((prev) => new Set(prev).add(selectedToolId))
    }
  }, [selectedToolId])

  const toggleExpanded = (toolId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(toolId)) {
        next.delete(toolId)
      } else {
        next.add(toolId)
      }
      return next
    })
  }

  if (!visible) return null

  return (
    <View className="absolute inset-0 flex-col" style={{ display: visible ? "flex" : "none" }}>
      {/* Header */}
      <View className="px-4 py-3 border-b border-border flex-row items-center gap-2">
        <Bot className="text-foreground" size={16} />
        <Text className="text-sm font-semibold text-foreground">Agents</Text>
        {entries.length > 0 && (
          <View className="px-1.5 py-0.5 rounded-full bg-muted">
            <Text className="text-[10px] font-medium text-muted-foreground">
              {entries.length}
            </Text>
          </View>
        )}
      </View>

      {entries.length === 0 ? (
        <View className="flex-1 items-center justify-center px-6 gap-3">
          <Bot className="text-muted-foreground/30" size={40} />
          <Text className="text-sm text-muted-foreground text-center">
            No sub-agents yet
          </Text>
          <Text className="text-xs text-muted-foreground/60 text-center">
            Sub-agents will appear here when the main agent spawns them to handle tasks.
          </Text>
        </View>
      ) : (
        <ScrollView
          className="flex-1"
          contentContainerClassName="px-4 py-3 gap-3 pb-8"
        >
          {entries.map(({ toolId, data }) => (
            <AgentEntry
              key={toolId}
              toolId={toolId}
              data={data}
              isExpanded={expandedIds.has(toolId)}
              onToggle={() => toggleExpanded(toolId)}
            />
          ))}
        </ScrollView>
      )}
    </View>
  )
}
