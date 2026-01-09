/**
 * TurnGroup Component
 * Task: task-chat-004
 *
 * Container for a complete conversation turn (user message + tool calls + assistant response).
 * Left border accent matches current phase color.
 */

import { cn } from "@/lib/utils"
import { usePhaseColor } from "@/hooks/usePhaseColor"
import type { ConversationTurn } from "./types"
import { TurnHeader } from "./TurnHeader"
import { MessageContent } from "./MessageContent"
import { ToolTimeline } from "../tools"
import { SubagentPanel, type SubagentProgress, type RecentTool } from "../subagent"

export interface TurnGroupProps {
  /** The conversation turn to render */
  turn: ConversationTurn
  /** Current phase for styling */
  phase?: string | null
  /** Active subagents for this turn */
  activeSubagents?: SubagentProgress[]
  /** Recent tool calls for subagent panel */
  recentTools?: RecentTool[]
  /** Optional class name */
  className?: string
}

/**
 * Renders a complete conversation turn as an atomic unit.
 *
 * Layout:
 * 1. User message (if present)
 * 2. Tool timeline (if tool calls present)
 * 3. Subagent panel (if subagents active)
 * 4. Assistant message (if present)
 *
 * Features:
 * - Left border accent using phase color
 * - Tool timeline integration
 * - Subagent panel integration
 * - Streaming support for assistant message
 *
 * @example
 * ```tsx
 * <TurnGroup
 *   turn={conversationTurn}
 *   phase="discovery"
 *   activeSubagents={activeSubagents}
 *   recentTools={recentTools}
 * />
 * ```
 */
export function TurnGroup({
  turn,
  phase,
  activeSubagents = [],
  recentTools = [],
  className,
}: TurnGroupProps) {
  const colors = usePhaseColor(phase || "")

  return (
    <div
      className={cn(
        "pl-3 border-l-2 space-y-3",
        turn.assistantMessage ? colors.border : "border-primary/30",
        className
      )}
    >
      {/* User message */}
      {turn.userMessage && (
        <div className="space-y-1">
          <TurnHeader role="user" />
          <MessageContent message={turn.userMessage} />
        </div>
      )}

      {/* Tool timeline */}
      {turn.toolCalls.length > 0 && (
        <ToolTimeline
          tools={turn.toolCalls}
          defaultExpanded={turn.toolCalls.length <= 3}
        />
      )}

      {/* Subagent panel (when there are active or recently-completed subagents) */}
      {activeSubagents.length > 0 && (
        <SubagentPanel
          subagents={activeSubagents}
          recentTools={recentTools}
          defaultExpanded
        />
      )}

      {/* Assistant message */}
      {turn.assistantMessage && (
        <div className="space-y-1">
          <TurnHeader role="assistant" phase={phase} />
          <MessageContent
            message={turn.assistantMessage}
            isStreaming={turn.isStreaming}
          />
        </div>
      )}

      {/* Loading indicator when streaming but no assistant message yet */}
      {turn.isStreaming && !turn.assistantMessage && (
        <div
          data-testid="loading-indicator"
          aria-label="Loading response"
          aria-busy="true"
          className="flex items-center gap-1 p-2"
        >
          <span className="w-2 h-2 rounded-full bg-muted-foreground animate-pulse" />
          <span className="w-2 h-2 rounded-full bg-muted-foreground animate-pulse [animation-delay:0.2s]" />
          <span className="w-2 h-2 rounded-full bg-muted-foreground animate-pulse [animation-delay:0.4s]" />
        </div>
      )}
    </div>
  )
}

export default TurnGroup
