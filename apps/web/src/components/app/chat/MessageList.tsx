/**
 * MessageList Component
 * Task: task-2-4-003 (message-list)
 *
 * Renders a scrollable list of ChatMessage components with auto-scroll behavior.
 * Shows loading indicator when isLoading is true.
 * Handles empty state gracefully.
 */

import * as React from "react"
import { useEffect, useRef } from "react"
import { cn } from "@/lib/utils"
import { ChatMessage, type ChatMessageProps } from "./ChatMessage"

export interface MessageListProps {
  messages: ChatMessageProps["message"][]
  isLoading?: boolean
  className?: string
}

export function MessageList({ messages, isLoading = false, className }: MessageListProps) {
  const scrollAnchorRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (scrollAnchorRef.current) {
      scrollAnchorRef.current.scrollIntoView({ behavior: "smooth" })
    }
  }, [messages])

  // Handle empty state
  if (messages.length === 0 && !isLoading) {
    return (
      <div
        className={cn(
          "flex flex-1 flex-col items-center justify-center overflow-y-auto p-4",
          className
        )}
      >
        <div
          data-testid="empty-state"
          className="text-center text-muted-foreground"
        >
          <p className="text-sm">No messages yet</p>
          <p className="text-xs mt-1">Start a conversation</p>
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        "flex flex-1 flex-col overflow-y-auto p-4 space-y-4",
        className
      )}
    >
      {messages.map((message) => (
        <ChatMessage key={message.id} message={message} />
      ))}

      {isLoading && (
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

      {/* Scroll anchor for auto-scroll behavior */}
      <div ref={scrollAnchorRef} data-testid="scroll-anchor" />
    </div>
  )
}
