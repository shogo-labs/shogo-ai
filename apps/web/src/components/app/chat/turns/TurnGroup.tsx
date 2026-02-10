/**
 * TurnGroup Component
 * Task: task-chat-004
 * Task: feat-chat-tool-interleaving
 *
 * Container for a complete conversation turn (user message + tool calls + assistant response).
 * Left border accent matches current phase color.
 * Now renders tool calls interleaved within assistant content.
 */

import { useState, useCallback } from "react"
import { Copy, Check } from "lucide-react"
import { cn } from "@/lib/utils"
import { usePhaseColor } from "@/hooks/usePhaseColor"
import type { ConversationTurn } from "./types"
import { TurnHeader } from "./TurnHeader"
import { MessageContent, extractTextContent } from "./MessageContent"
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
 * Small copy button that appears on hover over a message.
 * Shows a checkmark briefly after copying.
 */
function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement("textarea")
      textarea.value = text
      textarea.style.position = "fixed"
      textarea.style.opacity = "0"
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand("copy")
      document.body.removeChild(textarea)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }, [text])

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        "inline-flex items-center justify-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        "opacity-0 group-hover:opacity-100 focus:opacity-100",
        className
      )}
      aria-label={copied ? "Copied" : "Copy message"}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-green-500" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  )
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
 * - Copy button on hover for user and assistant messages
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
        <div className="group relative space-y-0.5">
          {/* <TurnHeader role="user" /> */}
          <MessageContent message={turn.userMessage} />
          <div className="flex justify-end">
            <CopyButton text={extractTextContent(turn.userMessage)} />
          </div>
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
        <div className="group relative space-y-0.5">
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
          {!turn.isStreaming && (
            <div className="flex justify-start pl-3">
              <CopyButton text={extractTextContent(turn.assistantMessage)} />
            </div>
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
