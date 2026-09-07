// SPDX-License-Identifier: MIT
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
import type { ToolCallData } from "../tools/types"

export interface TurnListProps {
  messages: UIMessage[]
  isStreaming?: boolean
  phase?: string | null
  subagentToolCalls?: ToolCallData[]
  className?: string
}

/**
 * Memoized so sibling ChatPanel re-renders (e.g. tab-switch re-renders of the
 * parent, which cascade into every open panel) don't re-run the full
 * TurnGroup / AssistantContent / Markdown render pipeline when the message
 * list itself hasn't changed. Callers MUST pass a referentially stable
 * `subagentToolCalls` (use useMemo) — otherwise memo bails out on every
 * render.
 */
export const TurnList = memo(
  function TurnList({
    messages,
    isStreaming = false,
    phase,
    subagentToolCalls,
    className,
  }: TurnListProps) {
    const turns = useTurnGrouping(messages, isStreaming, subagentToolCalls)

    return (
      <View className={cn("gap-4", className)}>
        {turns.map((turn) => (
          <TurnGroup key={turn.id} turn={turn} phase={phase} />
        ))}
      </View>
    )
  },
  (prev, next) =>
    prev.messages === next.messages &&
    prev.isStreaming === next.isStreaming &&
    prev.phase === next.phase &&
    prev.subagentToolCalls === next.subagentToolCalls &&
    prev.className === next.className,
)

export default TurnList
