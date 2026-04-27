// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * TurnList Component (React Native)
 *
 * Container that uses useTurnGrouping and renders TurnGroup components.
 */

import { memo } from "react"
import { View } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import type { UIMessage } from "@ai-sdk/react"
import { useTurnGrouping } from "./useTurnGrouping"
import { TurnGroup } from "./TurnGroup"
import type { SubagentProgress, RecentTool } from "../subagent"
import type { ToolCallData } from "../tools/types"

export interface TurnListProps {
  messages: UIMessage[]
  isStreaming?: boolean
  phase?: string | null
  activeSubagents?: SubagentProgress[]
  recentTools?: RecentTool[]
  subagentToolCalls?: ToolCallData[]
  className?: string
  /**
   * Phase 2.2 — collects 👍/👎 feedback for completed sub-agent runs.
   * Forwarded down to the TurnGroup → SubagentPanel for the *latest* turn only
   * (older turns are kept lean per the memo predicate below).
   */
  onSubagentFeedback?: (agentRunId: string, feedback: "up" | "down" | null) => Promise<void>
}

const EMPTY_SUBAGENTS: SubagentProgress[] = []
const EMPTY_RECENT_TOOLS: RecentTool[] = []

/**
 * Memoized so sibling ChatPanel re-renders (e.g. tab-switch re-renders of the
 * parent, which cascade into every open panel) don't re-run the full
 * TurnGroup / AssistantContent / Markdown render pipeline when the message
 * list itself hasn't changed. Callers MUST pass referentially stable
 * `activeSubagents`, `recentTools`, and `subagentToolCalls` (use useMemo) —
 * otherwise memo bails out on every render.
 */
export const TurnList = memo(
  function TurnList({
    messages,
    isStreaming = false,
    phase,
    activeSubagents = EMPTY_SUBAGENTS,
    recentTools = EMPTY_RECENT_TOOLS,
    subagentToolCalls,
    className,
    onSubagentFeedback,
  }: TurnListProps) {
    const turns = useTurnGrouping(messages, isStreaming, subagentToolCalls)

    return (
      <View className={cn("gap-4", className)}>
        {turns.map((turn, index) => (
          <TurnGroup
            key={turn.id}
            turn={turn}
            phase={phase}
            activeSubagents={index === turns.length - 1 ? activeSubagents : EMPTY_SUBAGENTS}
            recentTools={index === turns.length - 1 ? recentTools : EMPTY_RECENT_TOOLS}
            onSubagentFeedback={onSubagentFeedback}
          />
        ))}
      </View>
    )
  },
  (prev, next) =>
    prev.messages === next.messages &&
    prev.isStreaming === next.isStreaming &&
    prev.phase === next.phase &&
    prev.activeSubagents === next.activeSubagents &&
    prev.recentTools === next.recentTools &&
    prev.subagentToolCalls === next.subagentToolCalls &&
    prev.className === next.className &&
    prev.onSubagentFeedback === next.onSubagentFeedback,
)

export default TurnList
