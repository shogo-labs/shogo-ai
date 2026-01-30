/**
 * TurnList Component
 * Task: task-chat-004
 *
 * Container that uses useTurnGrouping and renders TurnGroup components.
 * Main replacement for the flat message loop in ChatPanel.
 */

import { cn } from "@/lib/utils"
import type { Message } from "@ai-sdk/react"
import { useTurnGrouping } from "./useTurnGrouping"
import { TurnGroup } from "./TurnGroup"
import type { SubagentProgress, RecentTool } from "../subagent"
import type { ToolCallData } from "../tools/types"

export interface TurnListProps {
  /** Array of AI SDK messages */
  messages: Message[]
  /** Whether the chat is currently streaming */
  isStreaming?: boolean
  /** Current phase for styling */
  phase?: string | null
  /** Active subagents (passed to TurnGroup) */
  activeSubagents?: SubagentProgress[]
  /** Recent tool calls for subagent panels */
  recentTools?: RecentTool[]
  /** Tool calls from subagent progress events (merged into timeline) */
  subagentToolCalls?: ToolCallData[]
  /** Optional class name */
  className?: string
}

/**
 * Renders messages grouped into conversation turns.
 *
 * Features:
 * - Uses useTurnGrouping hook for message grouping
 * - Renders TurnGroup for each turn
 * - Passes streaming state to the active turn
 * - Supports subagent panel integration
 *
 * @example
 * ```tsx
 * <TurnList
 *   messages={messages}
 *   isStreaming={isLoading}
 *   phase="discovery"
 *   activeSubagents={Array.from(activeSubagentsMap.values())}
 *   recentTools={recentTools}
 * />
 * ```
 */
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
    <div className={cn("space-y-4", className)}>
      {turns.map((turn, index) => (
        <TurnGroup
          key={turn.id}
          turn={turn}
          phase={phase}
          // Only pass subagent info to the last (active) turn
          activeSubagents={index === turns.length - 1 ? activeSubagents : []}
          recentTools={index === turns.length - 1 ? recentTools : []}
        />
      ))}
    </div>
  )
}

export default TurnList
