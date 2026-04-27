// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SubagentPanel Component (React Native)
 *
 * Inline subagent panel within TurnGroup.
 * Shows expandable stats for subagent execution.
 */

import { useState, useCallback } from "react"
import { View, Text, Pressable } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { ChevronDown, ChevronUp, Bot, ThumbsUp, ThumbsDown } from "lucide-react-native"
import { SubagentStats, type RecentTool } from "./SubagentStats"

export interface SubagentProgress {
  agentId: string
  agentType: string
  startTime: number
  status: "running" | "completed"
  toolCount: number
}

export interface SubagentPanelProps {
  subagents: SubagentProgress[]
  recentTools: RecentTool[]
  defaultExpanded?: boolean
  className?: string
  /**
   * Phase 2.2 — when provided, completed sub-agent runs render a 👍/👎 control
   * that calls back here with the user's verdict. The host is responsible for
   * POSTing to /api/subagent-runs/:id/feedback (see api.submitSubagentFeedback).
   */
  onSubmitFeedback?: (agentRunId: string, feedback: "up" | "down" | null) => Promise<void>
}

export function SubagentPanel({
  subagents,
  recentTools,
  defaultExpanded = true,
  className,
  onSubmitFeedback,
}: SubagentPanelProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)
  // agentId → user's verdict; tracked locally so the UI flips immediately even
  // before the network round-trip resolves.
  const [feedback, setFeedback] = useState<Record<string, "up" | "down" | null>>({})

  const runningCount = subagents.filter((s) => s.status === "running").length

  const handleFeedback = useCallback(
    async (agentId: string, verdict: "up" | "down") => {
      const current = feedback[agentId]
      // Tap-to-toggle: clicking the same button again clears the feedback so
      // users can recover from accidental clicks without leaving a wrong signal
      // in the data set.
      const next = current === verdict ? null : verdict
      setFeedback((prev) => ({ ...prev, [agentId]: next }))
      try {
        await onSubmitFeedback?.(agentId, next)
      } catch {
        // Roll back on failure so the UI matches what's persisted.
        setFeedback((prev) => ({ ...prev, [agentId]: current ?? null }))
      }
    },
    [feedback, onSubmitFeedback],
  )

  if (subagents.length === 0) {
    return null
  }

  return (
    <View
      className={cn(
        "rounded-md border border-gray-200/50 dark:border-gray-700/50 bg-gray-50/40 dark:bg-gray-900/40",
        "overflow-hidden",
        className
      )}
    >
      {/* Header */}
      <Pressable
        onPress={() => setIsExpanded(!isExpanded)}
        className="w-full flex-row items-center justify-between px-3 py-2"
      >
        <View className="flex-row items-center gap-2">
          <View
            className={cn(
              "w-2 h-2 rounded-full",
              runningCount > 0 ? "bg-primary" : "bg-green-500"
            )}
          />
          <Text className="text-xs font-semibold text-foreground/80">
            {runningCount > 0
              ? `Running Subagent${subagents.length > 1 ? "s" : ""}`
              : `Subagent${subagents.length > 1 ? "s" : ""} Complete`}
          </Text>
          {subagents.length > 1 && (
            <Text className="text-xs text-gray-400">
              ({subagents.length})
            </Text>
          )}
        </View>

        {isExpanded ? (
          <ChevronUp className="w-3.5 h-3.5 text-gray-400" size={14} />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 text-gray-400" size={14} />
        )}
      </Pressable>

      {/* Expanded content */}
      {isExpanded && (
        <View className="px-3 pb-3 gap-3">
          {subagents.map((subagent) => {
            const isRunning = subagent.status === "running"

            return (
              <View
                key={subagent.agentId}
                className={cn(
                  "pl-3 border-l-2",
                  isRunning ? "border-primary/30" : "border-green-500/30"
                )}
              >
                {/* Subagent type badge */}
                <View className="flex-row items-center gap-2 mb-2">
                  <Bot
                    className={cn(
                      "w-3.5 h-3.5",
                      isRunning ? "text-primary" : "text-green-500"
                    )}
                    size={14}
                  />
                  <Text
                    className={cn(
                      "text-xs font-medium px-2 py-0.5 rounded",
                      isRunning
                        ? "text-primary bg-primary/10"
                        : "text-green-500 bg-green-500/10"
                    )}
                  >
                    {subagent.agentType}
                  </Text>
                  {!isRunning && (
                    <Text className="text-xs text-gray-400">(complete)</Text>
                  )}

                  {/* Feedback controls — only show after the run completes and
                      only when the host wired up onSubmitFeedback. The verdict
                      is persisted on AgentCostMetric.userFeedback and used by
                      the recommendation gate (Phase 2.3). */}
                  {!isRunning && onSubmitFeedback && (
                    <View className="flex-row items-center gap-1 ml-auto">
                      <FeedbackButton
                        verdict="up"
                        active={feedback[subagent.agentId] === "up"}
                        onPress={() => handleFeedback(subagent.agentId, "up")}
                      />
                      <FeedbackButton
                        verdict="down"
                        active={feedback[subagent.agentId] === "down"}
                        onPress={() => handleFeedback(subagent.agentId, "down")}
                      />
                    </View>
                  )}
                </View>

                <SubagentStats
                  status={subagent.status}
                  startTime={subagent.startTime}
                  toolCount={subagent.toolCount}
                  recentTools={recentTools}
                />
              </View>
            )
          })}
        </View>
      )}
    </View>
  )
}

function FeedbackButton({
  verdict,
  active,
  onPress,
}: {
  verdict: "up" | "down"
  active: boolean
  onPress: () => void
}) {
  const Icon = verdict === "up" ? ThumbsUp : ThumbsDown
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      className={cn(
        "w-6 h-6 items-center justify-center rounded",
        active && verdict === "up" && "bg-green-500/15",
        active && verdict === "down" && "bg-red-500/15",
      )}
    >
      <Icon
        size={12}
        className={cn(
          active && verdict === "up" && "text-green-500",
          active && verdict === "down" && "text-red-400",
          !active && "text-gray-400",
        )}
      />
    </Pressable>
  )
}

export default SubagentPanel
