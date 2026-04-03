// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AssistantContent Component (React Native)
 *
 * Renders assistant message parts in order (text, tools, images interleaved).
 * Preserves the natural ordering from the AI SDK message.parts array.
 */

import { useState, useCallback, useMemo, useRef } from "react"
import { View, Text, Image, Pressable, Linking } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { FileText } from "lucide-react-native"
import type { UIMessage } from "@ai-sdk/react"
import { InlineToolWidget } from "./InlineToolWidget"
import { ExecWidget } from "./ExecWidget"
import {
  ConnectToolWidget,
  parseToolInstallResult,
} from "./ConnectToolWidget"
import { AskUserQuestionWidget } from "./AskUserQuestionWidget"
import { TodoWidget } from "./TodoWidget"
import { ToolCallGroup } from "./ToolCallGroup"
import type { MessagePart, GroupedMessagePart } from "./types"
import { type ToolCallData, getToolCategory } from "../tools/types"
import { useChatContextSafe } from "../ChatContext"
import { MarkdownText } from "../MarkdownText"
import { GenerateImageWidget } from "./GenerateImageWidget"
import { NotifyErrorWidget } from "./NotifyErrorWidget"
import { ThinkingWidget } from "./ThinkingWidget"
import { WriteFileWidget } from "./WriteFileWidget"
import { EditFileWidget } from "./EditFileWidget"

export interface AssistantContentProps {
  message: UIMessage
  isStreaming?: boolean
  className?: string
}

function mapToolState(state?: string): ToolCallData["state"] {
  if (state === "input-streaming") return "streaming"
  if (state === "output-available") return "success"
  if (state === "output-error") return "error"
  if (state === "result") return "success"
  if (state === "error") return "error"
  return "streaming"
}

function extractOrderedParts(message: UIMessage): MessagePart[] {
  const parts = (message as any).parts as any[] | undefined

  if (!parts || !Array.isArray(parts)) {
    if (
      typeof (message as any).content === "string" &&
      (message as any).content
    ) {
      return [{ type: "text", text: (message as any).content, id: "text-0" }]
    }
    return []
  }

  const result: MessagePart[] = []

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]

    if (part.type === "reasoning") {
      const hasContent = part.text?.trim().length > 0
      const isPartStreaming = "state" in part && part.state === "streaming"
      if (hasContent || isPartStreaming) {
        const durationMs = part.durationMs as number | undefined
        result.push({
          type: "reasoning",
          text: part.text || "",
          isStreaming: isPartStreaming,
          durationSeconds: durationMs ? Math.ceil(durationMs / 1000) : undefined,
          id: `reasoning-${index}`,
        })
      }
    } else if (part.type === "text") {
      if (part.text && part.text.trim()) {
        result.push({ type: "text", text: part.text, id: `text-${index}` })
      }
    } else if (part.type === "tool-invocation") {
      const inv = part.toolInvocation
      if (inv) {
        result.push({
          type: "tool",
          id: inv.toolCallId || `tool-${index}`,
          tool: {
            id: inv.toolCallId || `tool-${index}`,
            toolName: inv.toolName || "unknown",
            category: getToolCategory(inv.toolName || ""),
            state: mapToolState(inv.state),
            args: inv.args,
            result: inv.result,
            error: inv.error,
            timestamp: 0,
          },
        })
      }
    } else if (part.type === "dynamic-tool") {
      const toolCallId = part.toolCallId || `tool-${index}`
      const errorContent =
        part.state === "output-error"
          ? (part as { errorText?: string }).errorText ?? part.error
          : part.error
      result.push({
        type: "tool",
        id: toolCallId,
        tool: {
          id: toolCallId,
          toolName: part.toolName || "unknown",
          category: getToolCategory(part.toolName || ""),
          state: mapToolState(part.state),
          args: part.input,
          result: part.output,
          error: errorContent,
          timestamp: 0,
        },
      })
    } else if (part.type === "file" && part.url) {
      if (part.mediaType?.startsWith("image/")) {
        result.push({
          type: "image",
          url: part.url,
          mediaType: part.mediaType,
          id: `img-${index}`,
        })
      } else {
        result.push({
          type: "file",
          url: part.url,
          mediaType: part.mediaType || "application/octet-stream",
          id: `file-${index}`,
        })
      }
    }
  }

  return result
}

const UNGROUPABLE_TOOLS = new Set(["ask_user", "notify_user_error", "TodoWrite", "todo_write", "tool_install", "mcp_install", "generate_image", "exec", "Bash"])
const MIN_GROUP_SIZE = 2

function groupConsecutiveParts(parts: MessagePart[]): GroupedMessagePart[] {
  const result: GroupedMessagePart[] = []
  let i = 0

  while (i < parts.length) {
    const part = parts[i]

    if (part.type !== "tool" || UNGROUPABLE_TOOLS.has(part.tool.toolName)) {
      result.push(part)
      i++
      continue
    }

    const toolName = part.tool.toolName
    let j = i + 1
    while (
      j < parts.length &&
      parts[j].type === "tool" &&
      !UNGROUPABLE_TOOLS.has(
        (parts[j] as { type: "tool"; tool: ToolCallData }).tool.toolName
      ) &&
      (parts[j] as { type: "tool"; tool: ToolCallData }).tool.toolName ===
        toolName
    ) {
      j++
    }

    const runLength = j - i
    if (runLength >= MIN_GROUP_SIZE) {
      const groupTools = parts.slice(i, j).map((p) => ({
        tool: (p as { type: "tool"; tool: ToolCallData; id: string }).tool,
        id: p.id,
      }))
      result.push({
        type: "tool-group",
        toolName,
        tools: groupTools,
        id: `group-${parts[i].id}`,
      })
    } else {
      result.push(part)
    }

    i = j
  }

  return result
}

function ImageThumbnail({
  url,
  index,
}: {
  url: string
  mediaType: string
  index: number
}) {
  const [hasError, setHasError] = useState(false)

  const handlePress = useCallback(() => {
    Linking.openURL(url)
  }, [url])

  if (hasError) {
    return (
      <View className="max-w-[200px] rounded-md border border-border bg-muted p-2">
        <Text className="text-xs text-muted-foreground">
          Failed to load image
        </Text>
      </View>
    )
  }

  return (
    <Pressable onPress={handlePress} testID="image-thumbnail">
      <Image
        source={{ uri: url }}
        className="max-w-[280px] rounded-md"
        resizeMode="contain"
        accessibilityLabel={`Image attachment ${index + 1}`}
        onError={() => setHasError(true)}
        style={{ width: 280, aspectRatio: 4 / 3 }}
      />
    </Pressable>
  )
}

function FileThumbnail({
  mediaType,
  index,
}: {
  mediaType: string
  index: number
}) {
  const label = mediaType.includes("pdf")
    ? "PDF"
    : mediaType.split("/").pop()?.toUpperCase() || "FILE"

  return (
    <View
      className="flex-row items-center gap-2 rounded-md border border-border bg-muted px-3 py-2"
      accessibilityLabel={`File attachment ${index + 1}: ${label}`}
    >
      <FileText size={16} className="text-muted-foreground" />
      <Text className="text-xs text-muted-foreground">{label} attached</Text>
    </View>
  )
}

export function AssistantContent({
  message,
  isStreaming = false,
  className,
}: AssistantContentProps) {
  const chatContext = useChatContextSafe()

  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set())

  const toggleTool = useCallback((toolId: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev)
      if (next.has(toolId)) {
        next.delete(toolId)
      } else {
        next.add(toolId)
      }
      return next
    })
  }, [])

  const toggleCacheRef = useRef<Map<string, () => void>>(new Map())
  const getToggle = useCallback((id: string) => {
    let fn = toggleCacheRef.current.get(id)
    if (!fn) {
      fn = () => toggleTool(id)
      toggleCacheRef.current.set(id, fn)
    }
    return fn
  }, [toggleTool])

  const groupedParts = useMemo(() => {
    const parts = extractOrderedParts(message)
    return groupConsecutiveParts(parts)
  }, [message])

  if (groupedParts.length === 0) {
    return null
  }

  return (
    <View className={cn("gap-y-2", className)}>
      {groupedParts.map((part, index) => {
        if (part.type === "reasoning") {
          return (
            <ThinkingWidget
              key={part.id}
              text={part.text}
              isStreaming={part.isStreaming}
              durationSeconds={part.durationSeconds}
            />
          )
        }

        if (part.type === "text") {
          return (
            <View key={part.id}>
              <MarkdownText
                className="text-foreground text-xs prose-sm"
                isStreaming={isStreaming}
              >
                {part.text}
              </MarkdownText>
            </View>
          )
        }

        if (part.type === "tool-group") {
          return (
            <ToolCallGroup
              key={part.id}
              toolName={part.toolName}
              tools={part.tools}
              isExpanded={expandedTools.has(part.id)}
              onToggle={getToggle(part.id)}
            />
          )
        }

        if (part.type === "tool") {
          if (part.tool.toolName === "ask_user") {
            const isPending = part.tool.result === undefined
            const isExpanded = isPending || expandedTools.has(part.id)

            return (
              <AskUserQuestionWidget
                key={part.id}
                tool={part.tool}
                isExpanded={isExpanded}
                onToggle={getToggle(part.id)}
                onSubmitResponse={(response) => {
                  if (chatContext?.sendMessage) {
                    chatContext.sendMessage(response)
                  }
                }}
              />
            )
          }

          if (part.tool.toolName === "TodoWrite" || part.tool.toolName === "todo_write") {
            const isExpanded = !expandedTools.has(part.id)

            return (
              <TodoWidget
                key={part.id}
                tool={part.tool}
                isExpanded={isExpanded}
                onToggle={getToggle(part.id)}
              />
            )
          }

          if (part.tool.toolName === "tool_install" && part.tool.state === "success") {
            const installResult = parseToolInstallResult(part.tool.result)
            if (installResult?.authStatus === "needs_auth" && installResult?.authUrl) {
              return (
                <ConnectToolWidget
                  key={part.id}
                  toolkitName={installResult.integration || "Service"}
                  authUrl={installResult.authUrl}
                  toolCount={installResult.toolCount || 0}
                />
              )
            }
          }

          if (part.tool.toolName === "generate_image") {
            return (
              <GenerateImageWidget key={part.id} tool={part.tool} />
            )
          }

          if (part.tool.toolName === "notify_user_error") {
            return (
              <NotifyErrorWidget key={part.id} tool={part.tool} />
            )
          }

          if (part.tool.toolName === "exec" || part.tool.toolName === "Bash") {
            return (
              <ExecWidget
                key={part.id}
                tool={part.tool}
                isExpanded={expandedTools.has(part.id)}
                onToggle={getToggle(part.id)}
              />
            )
          }

          if (part.tool.toolName === "write_file" || part.tool.toolName === "Write") {
            return (
              <WriteFileWidget
                key={part.id}
                tool={part.tool}
                isExpanded={expandedTools.has(part.id)}
                onToggle={getToggle(part.id)}
              />
            )
          }

          if (part.tool.toolName === "edit_file" || part.tool.toolName === "Edit" || part.tool.toolName === "StrReplace") {
            return (
              <EditFileWidget
                key={part.id}
                tool={part.tool}
                isExpanded={expandedTools.has(part.id)}
                onToggle={getToggle(part.id)}
              />
            )
          }

          return (
            <InlineToolWidget
              key={part.id}
              tool={part.tool}
              isExpanded={expandedTools.has(part.id)}
              onToggle={getToggle(part.id)}
            />
          )
        }

        if (part.type === "image") {
          return (
            <ImageThumbnail
              key={part.id}
              url={part.url}
              mediaType={part.mediaType}
              index={index}
            />
          )
        }

        if (part.type === "file") {
          return (
            <FileThumbnail
              key={part.id}
              mediaType={part.mediaType}
              index={index}
            />
          )
        }

        return null
      })}
    </View>
  )
}

export default AssistantContent
