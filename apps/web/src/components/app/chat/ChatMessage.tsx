/**
 * ChatMessage Component
 * Task: task-2-4-002 (chat-presentational-components)
 *
 * Renders user/assistant chat messages with role-based styling.
 * User messages are right-aligned, assistant messages are left-aligned.
 * Supports streaming state with typing indicator.
 */

import * as React from "react"
import { cn } from "@/lib/utils"

export interface ChatMessageProps {
  message: {
    id: string
    role: "user" | "assistant"
    content: string
  }
  isStreaming?: boolean
}

export function ChatMessage({ message, isStreaming = false }: ChatMessageProps) {
  const isUser = message.role === "user"

  return (
    <div
      className={cn(
        "flex w-full",
        isUser ? "justify-end" : "justify-start"
      )}
    >
      <div
        data-testid="message-content"
        className={cn(
          "max-w-[80%] rounded-lg px-4 py-2 text-sm",
          isUser
            ? "bg-primary text-primary-foreground ml-auto"
            : "bg-muted text-foreground mr-auto"
        )}
      >
        <div className="whitespace-pre-wrap break-words">{message.content}</div>

        {isStreaming && !isUser && (
          <div
            data-testid="typing-indicator"
            aria-label="Assistant is typing"
            aria-busy="true"
            className="flex items-center gap-1 mt-2"
          >
            <span className="w-2 h-2 rounded-full bg-foreground/50 animate-pulse" />
            <span className="w-2 h-2 rounded-full bg-foreground/50 animate-pulse [animation-delay:0.2s]" />
            <span className="w-2 h-2 rounded-full bg-foreground/50 animate-pulse [animation-delay:0.4s]" />
          </div>
        )}
      </div>
    </div>
  )
}
