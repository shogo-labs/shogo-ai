// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * TurnGroup Component (React Native)
 *
 * Container for a complete conversation turn (user message + tool calls + assistant response).
 * Renders tool calls interleaved within assistant content.
 */

import { useState, useCallback } from "react"
import { View, Text, Pressable } from "react-native"
import * as Clipboard from "expo-clipboard"
import { Copy, Check } from "lucide-react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { usePhaseColor } from "@/hooks/usePhaseColor"
import type { ConversationTurn } from "./types"
import { TurnHeader } from "./TurnHeader"
import { MessageContent, extractTextContent } from "./MessageContent"
import { AssistantContent } from "./AssistantContent"
import { ToolTimeline } from "../tools"
import { SubagentPanel, type SubagentProgress, type RecentTool } from "../subagent"

export interface TurnGroupProps {
  turn: ConversationTurn
  phase?: string | null
  activeSubagents?: SubagentProgress[]
  recentTools?: RecentTool[]
  showToolTimeline?: boolean
  className?: string
}

function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    if (!text) return
    try {
      await Clipboard.setStringAsync(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Silently fail on copy error
    }
  }, [text])

  return (
    <Pressable
      onPress={handleCopy}
      className={cn(
        "items-center justify-center rounded-lg p-1",
        className
      )}
      accessibilityLabel={copied ? "Copied" : "Copy message"}
    >
      {copied ? (
        <Check className="h-4 w-4 text-green-500" />
      ) : (
        <Copy className="h-4 w-4 text-muted-foreground" />
      )}
    </Pressable>
  )
}

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
    <View
      className={cn(
        "gap-2",
        turn.assistantMessage ? colors.border : "border-primary/30",
        className
      )}
    >
      {/* User message */}
      {turn.userMessage && (
        <View className="w-full flex-row items-end justify-end gap-2">
          <MessageContent message={turn.userMessage} className="ml-0" />
        </View>
      )}

      {/* Tool timeline (legacy mode only) */}
      {showToolTimeline && turn.toolCalls.length > 0 && (
        <ToolTimeline
          tools={turn.toolCalls}
          defaultExpanded={turn.toolCalls.length <= 3}
        />
      )}

      {/* Subagent panel */}
      {activeSubagents.length > 0 && (
        <SubagentPanel
          subagents={activeSubagents}
          recentTools={recentTools}
          defaultExpanded
        />
      )}

      {/* Assistant message with interleaved tools (default) or plain content (legacy) */}
      {turn.assistantMessage && (
        <View className="gap-0.5">
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
            <View className="flex-row justify-start pl-3">
              <CopyButton text={extractTextContent(turn.assistantMessage)} />
            </View>
          )}
        </View>
      )}

      {/* Loading indicator when streaming but no assistant message yet */}
      {turn.isStreaming && !turn.assistantMessage && (
        <View
          testID="loading-indicator"
          accessibilityLabel="Loading response"
          accessibilityState={{ busy: true }}
          className="flex-row items-center gap-1 p-2"
        >
          <View className="w-2 h-2 rounded-full bg-muted-foreground opacity-60" />
          <View className="w-2 h-2 rounded-full bg-muted-foreground opacity-40" />
          <View className="w-2 h-2 rounded-full bg-muted-foreground opacity-20" />
        </View>
      )}
    </View>
  )
}

export default TurnGroup
