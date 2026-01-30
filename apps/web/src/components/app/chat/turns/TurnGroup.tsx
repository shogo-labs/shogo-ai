/**
 * TurnGroup Component
 * Task: task-chat-004
 * Task: feat-chat-tool-interleaving
 *
 * Container for a complete conversation turn (user message + tool calls + assistant response).
 * Left border accent matches current phase color.
 * Now renders tool calls interleaved within assistant content.
 */

import { cn } from "@/lib/utils"
import { usePhaseColor } from "@/hooks/usePhaseColor"
import type { ConversationTurn } from "./types"
import { TurnHeader } from "./TurnHeader"
import { MessageContent } from "./MessageContent"
import { AssistantContent } from "./AssistantContent"
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
  /** Show tool calls in a separate timeline above content (legacy mode) */
  showToolTimeline?: boolean
  /** Optional class name */
  className?: string
}

/**
 * Renders a complete conversation turn as an atomic unit.
 *
 * Layout (default interleaved mode):
 * 1. User message (if present)
 * 2. Subagent panel (if subagents active)
 * 3. Assistant content with interleaved tool widgets
 *
 * Layout (legacy mode with showToolTimeline=true):
 * 1. User message (if present)
 * 2. Tool timeline (if tool calls present)
 * 3. Subagent panel (if subagents active)
 * 4. Assistant message (if present)
 *
 * Features:
 * - Left border accent using phase color
 * - Interleaved tool calls within assistant content (default)
 * - Optional separate tool timeline (legacy mode)
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
  showToolTimeline = false,
  className,
}: TurnGroupProps) {
  const colors = usePhaseColor(phase || "")

  return (
    <div
      className={cn(
        "space-y-2",
        turn.assistantMessage ? colors.border : "border-primary/30",
        className
      )}
    >
      {/* User message */}
      {turn.userMessage && (
        <div className="space-y-0.5">
          {/* <TurnHeader role="user" /> */}
          <MessageContent message={turn.userMessage} />
        </div>
      )}

      {/* Tool timeline (legacy mode only) */}
      {showToolTimeline && turn.toolCalls.length > 0 && (
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

      {/* Assistant message with interleaved tools (default) or plain content (legacy) */}
      {turn.assistantMessage && (
        <div className="space-y-0.5">
          <TurnHeader role="assistant" phase={phase} />
          {showToolTimeline ? (
            <MessageContent
              message={turn.assistantMessage}
              isStreaming={turn.isStreaming}
            />
          ) : (
            <AssistantContent
              message={turn.assistantMessage}
              isStreaming={turn.isStreaming}
            />
          )}
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
