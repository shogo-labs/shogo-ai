/**
 * MessageContent Component
 * Task: task-chat-004
 *
 * Renders message text with role-appropriate styling.
 * Integrates StreamingText for assistant messages during streaming.
 */

import { cn } from "@/lib/utils"
import type { Message } from "@ai-sdk/react"
import { StreamingText } from "../streaming"

export interface MessageContentProps {
  /** The message to render */
  message: Message
  /** Whether this message is currently streaming */
  isStreaming?: boolean
  /** Optional class name */
  className?: string
}

/**
 * Extract text content from a message.
 * Handles AI SDK v3 parts array format.
 */
function extractTextContent(message: Message): string {
  // If message has content string, use it
  if (typeof message.content === "string" && message.content) {
    return message.content
  }

  // v3 API: Extract text from parts array
  if ("parts" in message && Array.isArray((message as any).parts)) {
    return ((message as any).parts as any[])
      .filter((part) => part.type === "text")
      .map((part) => part.text || "")
      .join("")
  }

  return ""
}

/**
 * Renders message content with appropriate styling.
 *
 * Features:
 * - Role-based styling (user vs assistant)
 * - StreamingText integration for animated text reveal
 * - Whitespace preservation for formatted content
 *
 * @example
 * ```tsx
 * <MessageContent message={assistantMessage} isStreaming={isLoading} />
 * ```
 */
export function MessageContent({
  message,
  isStreaming = false,
  className,
}: MessageContentProps) {
  const content = extractTextContent(message)
  const isUser = message.role === "user"

  // User messages: simple text display
  if (isUser) {
    return (
      <div
        className={cn(
          "max-w-[85%] rounded-lg px-4 py-2 text-sm",
          "bg-primary text-primary-foreground ml-auto",
          "whitespace-pre-wrap break-words",
          className
        )}
      >
        {content}
      </div>
    )
  }

  // Assistant messages: use StreamingText when streaming
  return (
    <div
      className={cn(
        "max-w-[85%] rounded-lg px-4 py-2 text-sm",
        "bg-muted text-foreground mr-auto",
        className
      )}
    >
      {isStreaming ? (
        <StreamingText
          content={content}
          isStreaming={isStreaming}
          showCursor
        />
      ) : (
        <span className="whitespace-pre-wrap break-words">{content}</span>
      )}
    </div>
  )
}

export default MessageContent
