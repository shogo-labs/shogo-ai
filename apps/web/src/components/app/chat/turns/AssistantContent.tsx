/**
 * AssistantContent Component
 * Task: feat-chat-tool-interleaving
 *
 * Renders assistant message parts in order (text, tools, images interleaved).
 * Preserves the natural ordering from the AI SDK message.parts array.
 */

import { useState, useCallback, useMemo } from "react"
import { cn } from "@/lib/utils"
import type { Message } from "@ai-sdk/react"
import { Streamdown } from "streamdown"
import { InlineToolWidget } from "./InlineToolWidget"
import { AskUserQuestionWidget } from "./AskUserQuestionWidget"
import { TodoWidget } from "./TodoWidget"
import type { MessagePart } from "./types"
import { type ToolCallData, getToolCategory } from "../tools/types"
import { useChatContextSafe } from "../ChatContext"

export interface AssistantContentProps {
  /** The assistant message to render */
  message: Message
  /** Whether this message is currently streaming */
  isStreaming?: boolean
  /** Optional class name */
  className?: string
}

/**
 * Map AI SDK tool state to our ToolExecutionState
 * Handles both standard tool-invocation states and dynamic-tool states
 */
function mapToolState(state?: string): ToolCallData["state"] {
  // Claude Code dynamic-tool: input-streaming, output-available, output-error
  if (state === "input-streaming") return "streaming"
  if (state === "output-available") return "success"
  if (state === "output-error") return "error"
  // Standard AI SDK tool-invocation: result, error
  if (state === "result") return "success"
  if (state === "error") return "error"

  return "streaming"
}

/**
 * Extract ordered parts from an AI SDK message.
 * Preserves the natural interleaving of text, tools, and images.
 */
function extractOrderedParts(message: Message): MessagePart[] {
  const parts = (message as any).parts as any[] | undefined

  // DEBUG: Log what we're receiving
  // console.log("[AssistantContent] extractOrderedParts called", {
  //   messageId: message.id,
  //   hasPartsArray: Array.isArray(parts),
  //   partsLength: parts?.length,
  //   partTypes: parts?.map((p: any) => p.type),
  //   rawParts: parts,
  // })

  // Fallback: single text part from content
  if (!parts || !Array.isArray(parts)) {
    // console.log("[AssistantContent] Falling back to message.content")
    if (typeof message.content === "string" && message.content) {
      return [{ type: "text", text: message.content, id: "text-0" }]
    }
    return []
  }

  const result: MessagePart[] = []

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]

    if (part.type === "text") {
      // Skip empty text parts
      if (part.text && part.text.trim()) {
        result.push({ type: "text", text: part.text, id: `text-${index}` })
      }
    } else if (part.type === "tool-invocation") {
      // Standard AI SDK tool-invocation format
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
            timestamp: Date.now(),
          },
        })
      }
    } else if (part.type === "dynamic-tool") {
      // Claude Code provider dynamic-tool format
      // Data is directly on the part, not nested in toolInvocation
      const toolCallId = part.toolCallId || `tool-${index}`
      // For output-error, AI SDK puts error content in errorText, not output/error
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
          args: part.input, // dynamic-tool uses 'input' not 'args'
          result: part.output, // dynamic-tool uses 'output' not 'result'
          error: errorContent,
          timestamp: Date.now(),
        },
      })
    } else if (
      part.type === "file" &&
      part.mediaType?.startsWith("image/") &&
      part.url
    ) {
      result.push({
        type: "image",
        url: part.url,
        mediaType: part.mediaType,
        id: `img-${index}`,
      })
    }
  }

  // console.log("[AssistantContent] extractOrderedParts result", {
  //   inputPartsCount: parts.length,
  //   outputPartsCount: result.length,
  //   outputTypes: result.map((p) => p.type),
  // })

  return result
}

/**
 * Image thumbnail component with click-to-expand
 */
function ImageThumbnail({
  url,
  mediaType,
  index,
}: {
  url: string
  mediaType: string
  index: number
}) {
  const [hasError, setHasError] = useState(false)

  const handleClick = useCallback(() => {
    window.open(url, "_blank")
  }, [url])

  const handleError = useCallback(() => {
    setHasError(true)
  }, [])

  if (hasError) {
    return (
      <div className="max-w-[200px] rounded-md border border-border bg-muted p-2 text-xs text-muted-foreground">
        Failed to load image
      </div>
    )
  }

  return (
    <img
      src={url}
      alt={`Image attachment ${index + 1}`}
      className="max-w-[200px] max-h-[150px] rounded-md border border-border object-contain cursor-pointer hover:opacity-90 transition-opacity"
      onClick={handleClick}
      onError={handleError}
      data-testid="image-thumbnail"
    />
  )
}

/**
 * Renders assistant message with interleaved text, tools, and images.
 *
 * Unlike MessageContent which concatenates all text, this component
 * preserves the natural ordering from message.parts, rendering
 * tool widgets inline at their actual position in the response.
 *
 * @example
 * ```tsx
 * <AssistantContent message={assistantMessage} isStreaming={isLoading} />
 * ```
 */
export function AssistantContent({
  message,
  isStreaming = false,
  className,
}: AssistantContentProps) {
  // Get sendMessage from context for AskUserQuestion responses
  const chatContext = useChatContextSafe()

  // Track which tools are expanded
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

  // Extract ordered parts from message
  const parts = useMemo(() => extractOrderedParts(message), [message])

  // If no parts, show nothing
  if (parts.length === 0) {
    return null
  }

  return (
    <div className={cn("space-y-1.5", className)}>
      {parts.map((part, index) => {
        const isLastPart = index === parts.length - 1

        if (part.type === "text") {
          return (
            <div
              key={part.id}
              className="px-3 py-1.5 text-foreground text-xs"
            >
              <Streamdown>{part.text}</Streamdown>
            </div>
          )
        }

        if (part.type === "tool") {
          // Special handling for AskUserQuestion - render interactive widget
          if (part.tool.toolName === "AskUserQuestion") {
            // Auto-expand when pending (no result yet)
            const isPending = part.tool.result === undefined
            const isExpanded = isPending || expandedTools.has(part.id)

            return (
              <AskUserQuestionWidget
                key={part.id}
                tool={part.tool}
                isExpanded={isExpanded}
                onToggle={() => toggleTool(part.id)}
                onSubmitResponse={(response) => {
                  if (chatContext?.sendMessage) {
                    chatContext.sendMessage(response)
                  }
                }}
              />
            )
          }

          // Special handling for TodoWrite - render task list widget
          if (part.tool.toolName === "TodoWrite") {
            // Default to expanded for todos
            const isExpanded = !expandedTools.has(part.id) // Inverted - collapsed when in set
            
            return (
              <TodoWidget
                key={part.id}
                tool={part.tool}
                isExpanded={isExpanded}
                onToggle={() => toggleTool(part.id)}
              />
            )
          }

          // Default tool widget for everything else
          return (
            <InlineToolWidget
              key={part.id}
              tool={part.tool}
              isExpanded={expandedTools.has(part.id)}
              onToggle={() => toggleTool(part.id)}
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

        return null
      })}
    </div>
  )
}

export default AssistantContent
