/**
 * TurnGroup Component (React Native)
 *
 * Container for a complete conversation turn (user message + tool calls + assistant response).
 * Renders tool calls interleaved within assistant content.
 * Supports inline message editing (ChatGPT/Cursor-style).
 */

import { useState, useCallback, useRef, useEffect } from "react"
import { View, Text, Pressable, TextInput, Platform, type NativeSyntheticEvent, type TextInputKeyPressEventData } from "react-native"
import * as Clipboard from "expo-clipboard"
import { Copy, Check, Pencil, X, ArrowUp } from "lucide-react-native"
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
  onEditMessage?: (messageId: string, newContent: string) => void
  isStreaming?: boolean
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
        "items-center justify-center rounded-md p-1",
        className
      )}
      accessibilityLabel={copied ? "Copied" : "Copy message"}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-green-500" />
      ) : (
        <Copy className="h-3.5 w-3.5 text-muted-foreground" />
      )}
    </Pressable>
  )
}

function EditableUserMessage({
  messageId,
  originalText,
  onSubmit,
  onCancel,
}: {
  messageId: string
  originalText: string
  onSubmit: (messageId: string, newContent: string) => void
  onCancel: () => void
}) {
  const [editText, setEditText] = useState(originalText)
  const inputRef = useRef<TextInput>(null)

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 100)
  }, [])

  const handleSubmit = useCallback(() => {
    const trimmed = editText.trim()
    if (trimmed) {
      onSubmit(messageId, trimmed)
    } else {
      onCancel()
    }
  }, [editText, messageId, onSubmit, onCancel])

  return (
    <View className="max-w-[85%] ml-auto gap-2">
      <View className="rounded-xl border border-primary/40 bg-muted/50 overflow-hidden">
        <TextInput
          ref={inputRef}
          value={editText}
          onChangeText={setEditText}
          multiline
          className="px-3 py-2 text-xs text-foreground min-h-[40px] max-h-[200px] outline-none"
          textAlignVertical="top"
          onKeyPress={(e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
            const nativeEvent = e.nativeEvent as TextInputKeyPressEventData & { shiftKey?: boolean }
            if (Platform.OS === "web" && nativeEvent.key === "Enter" && !nativeEvent.shiftKey) {
              e.preventDefault?.()
              handleSubmit()
            }
          }}
        />
      </View>
      <View className="flex-row justify-end gap-2">
        <Pressable
          onPress={onCancel}
          className="flex-row items-center gap-1.5 rounded-lg border border-border px-3 py-1.5"
        >
          <X className="h-3 w-3 text-muted-foreground" size={12} />
          <Text className="text-xs text-muted-foreground font-medium">
            Cancel
          </Text>
        </Pressable>
        <Pressable
          onPress={handleSubmit}
          disabled={!editText.trim()}
          className={cn(
            "flex-row items-center gap-1.5 rounded-lg px-3 py-1.5 bg-primary",
            !editText.trim() && "opacity-50"
          )}
        >
          <ArrowUp className="h-3 w-3 text-primary-foreground" size={12} />
          <Text className="text-xs text-primary-foreground font-medium">
            Send
          </Text>
        </Pressable>
      </View>
    </View>
  )
}

export function TurnGroup({
  turn,
  phase,
  activeSubagents = [],
  recentTools = [],
  showToolTimeline = false,
  onEditMessage,
  isStreaming = false,
  className,
}: TurnGroupProps) {
  const colors = usePhaseColor(phase || "")
  const [isEditing, setIsEditing] = useState(false)
  const [isHovered, setIsHovered] = useState(false)

  const canEdit = !!onEditMessage && !isStreaming && !!turn.userMessage

  const handleStartEdit = useCallback(() => {
    if (canEdit) setIsEditing(true)
  }, [canEdit])

  const handleCancelEdit = useCallback(() => {
    setIsEditing(false)
  }, [])

  const handleSubmitEdit = useCallback(
    (messageId: string, newContent: string) => {
      onEditMessage?.(messageId, newContent)
    },
    [onEditMessage]
  )

  const hoverHandlers: Record<string, () => void> =
    Platform.OS === "web" && canEdit
      ? {
          onMouseEnter: () => setIsHovered(true),
          onMouseLeave: () => setIsHovered(false),
        }
      : {}

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
        <View className="gap-0.5">
          {isEditing ? (
            <EditableUserMessage
              messageId={turn.userMessage.id}
              originalText={extractTextContent(turn.userMessage)}
              onSubmit={handleSubmitEdit}
              onCancel={handleCancelEdit}
            />
          ) : (
            <View {...hoverHandlers}>
              <MessageContent message={turn.userMessage} />
              <View className="flex-row justify-end items-center gap-0.5">
                {canEdit && (
                  <Pressable
                    onPress={handleStartEdit}
                    className={cn(
                      "items-center justify-center rounded-md p-1",
                      Platform.OS === "web" && !isHovered && "opacity-0"
                    )}
                    accessibilityLabel="Edit message"
                  >
                    <Pencil
                      className="h-3.5 w-3.5 text-muted-foreground"
                      size={14}
                    />
                  </Pressable>
                )}
                <CopyButton text={extractTextContent(turn.userMessage)} />
              </View>
            </View>
          )}
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
