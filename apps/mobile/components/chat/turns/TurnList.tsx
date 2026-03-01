/**
 * TurnList Component (React Native)
 *
 * Container that uses useTurnGrouping and renders TurnGroup components.
 */

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
}

export function TurnList({
  messages,
  isStreaming = false,
  phase,
  activeSubagents = [],
  recentTools = [],
  subagentToolCalls,
  className,
}: TurnListProps) {
  const turns = useTurnGrouping(messages, isStreaming, subagentToolCalls)

  return (
    <View className={cn("gap-4", className)}>
      {turns.map((turn, index) => (
        <TurnGroup
          key={turn.id}
          turn={turn}
          phase={phase}
          activeSubagents={index === turns.length - 1 ? activeSubagents : []}
          recentTools={index === turns.length - 1 ? recentTools : []}
        />
      ))}
    </View>
  )
}

export default TurnList
