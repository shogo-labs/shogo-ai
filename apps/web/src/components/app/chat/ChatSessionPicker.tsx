/**
 * ChatSessionPicker Component
 * Task: task-2-4-002 (chat-presentational-components)
 *
 * Renders a dropdown menu for selecting chat sessions.
 * Shows session name, message count, and relative time for each session.
 * Includes a "New Chat" option at the bottom.
 */

import * as React from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ChevronDown, MessageSquare, Plus } from "lucide-react"

export interface ChatSession {
  id: string
  name: string
  messageCount: number
  updatedAt: number
}

export interface ChatSessionPickerProps {
  sessions: ChatSession[]
  currentSessionId?: string
  onSelect: (sessionId: string) => void
  onCreate: () => void
}

/**
 * Format timestamp as relative time (e.g., "5m ago", "1h ago", "1d ago")
 */
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp

  const minutes = Math.floor(diff / (1000 * 60))
  const hours = Math.floor(diff / (1000 * 60 * 60))
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))

  if (days > 0) {
    return `${days}d ago`
  } else if (hours > 0) {
    return `${hours}h ago`
  } else if (minutes > 0) {
    return `${minutes}m ago`
  } else {
    return "just now"
  }
}

export function ChatSessionPicker({
  sessions,
  currentSessionId,
  onSelect,
  onCreate,
}: ChatSessionPickerProps) {
  const currentSession = sessions.find(s => s.id === currentSessionId)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          data-testid="session-picker-trigger"
          variant="ghost"
          className="flex items-center gap-2 text-sm"
        >
          <MessageSquare className="h-4 w-4" />
          <span className="truncate max-w-[150px]">
            {currentSession?.name ?? "Select Chat"}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        data-testid="session-list"
        align="start"
        className="w-[280px]"
      >
        {sessions.map((session) => (
          <DropdownMenuItem
            key={session.id}
            data-session-id={session.id}
            onClick={() => onSelect(session.id)}
            className={cn(
              "flex flex-col items-start gap-1 cursor-pointer",
              session.id === currentSessionId && "bg-accent"
            )}
          >
            <div className="flex items-center justify-between w-full">
              <span className="font-medium truncate">{session.name}</span>
              <span className="text-xs text-muted-foreground">
                {formatRelativeTime(session.updatedAt)}
              </span>
            </div>
            <span className="text-xs text-muted-foreground">
              {session.messageCount} messages
            </span>
          </DropdownMenuItem>
        ))}

        {sessions.length > 0 && <DropdownMenuSeparator />}

        <DropdownMenuItem
          data-testid="new-chat-option"
          onClick={onCreate}
          className="cursor-pointer"
        >
          <Plus className="h-4 w-4 mr-2" />
          New Chat
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
