// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * TurnList Component (React Native)
 *
 * Container that uses useTurnGrouping and renders TurnGroup components.
 *
 * While a past message is open in the in-place editor (SHO-263) every turn
 * below it is dimmed and non-interactive, under a "N messages below will be
 * replaced" divider, so the user can see exactly what the resend will drop.
 */

import { memo } from "react"
import { Text, View } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import type { UIMessage } from "@ai-sdk/react"
import { useTurnGrouping } from "./useTurnGrouping"
import { TurnGroup } from "./TurnGroup"
import { useMessageEditContext } from "./MessageEditContext"
import { firstDimmedTurnIndex, replacedTurnsLabel } from "./editResend"
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
 *
 * The edit-dimming state comes from context, which re-renders this component
 * even when the memo bails out on props.
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
    const ctx = useMessageEditContext()
    const editingMessageId = ctx?.editingMessageId ?? null
    const dimFrom = firstDimmedTurnIndex(turns, editingMessageId)
    const replacedCount =
      ctx && editingMessageId ? ctx.countMessagesAfter(editingMessageId) : 0

    return (
      <View className={cn("gap-4", className)}>
        {turns.map((turn, index) => {
          const dimmed = dimFrom >= 0 && index >= dimFrom
          const dimTail = dimFrom > 0 && index === dimFrom - 1
          return (
            <View key={turn.id} className="gap-2">
              {dimmed && index === dimFrom ? (
                <View className="flex-row items-center gap-2 py-1">
                  <View className="h-px flex-1 bg-border/60" />
                  <Text className="text-[11px] text-muted-foreground">
                    {replacedTurnsLabel(replacedCount)}
                  </Text>
                  <View className="h-px flex-1 bg-border/60" />
                </View>
              ) : null}
              <TurnGroup
                turn={turn}
                phase={phase}
                summaryCard={index === turns.length - 1}
                dimmed={dimmed}
                dimTail={dimTail}
              />
            </View>
          )
        })}
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
