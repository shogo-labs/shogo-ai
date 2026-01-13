/**
 * ChatSessionPicker Component
 * Task: task-2-4-002 (chat-presentational-components)
 *
 * Renders a dropdown menu for selecting chat sessions.
 * Shows session name, message count, and relative time for each session.
 * Includes a "New Chat" option at the bottom and optional rename functionality.
 */

import * as React from "react"
import { useState, useRef, useEffect } from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ChevronDown, MessageSquare, Plus, Pencil, Check, X } from "lucide-react"

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
  /** Optional callback to rename a session */
  onRename?: (sessionId: string, newName: string) => void
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
  onRename,
}: ChatSessionPickerProps) {
  const currentSession = sessions.find(s => s.id === currentSessionId)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus input when editing starts
  useEffect(() => {
    if (editingSessionId && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingSessionId])

  const handleStartEdit = (e: React.MouseEvent, session: ChatSession) => {
    e.stopPropagation()
    setEditingSessionId(session.id)
    setEditValue(session.name)
  }

  const handleSaveEdit = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (editingSessionId && editValue.trim() && onRename) {
      onRename(editingSessionId, editValue.trim())
    }
    setEditingSessionId(null)
  }

  const handleCancelEdit = (e: React.MouseEvent) => {
    e.stopPropagation()
    setEditingSessionId(null)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Prevent Radix DropdownMenu typeahead navigation from intercepting keypresses
    e.stopPropagation()
    if (e.key === "Enter" && editingSessionId && editValue.trim() && onRename) {
      onRename(editingSessionId, editValue.trim())
      setEditingSessionId(null)
    } else if (e.key === "Escape") {
      setEditingSessionId(null)
    }
  }

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
        align="end"
        className="w-[280px]"
      >
        {sessions.map((session) => (
          <DropdownMenuItem
            key={session.id}
            data-session-id={session.id}
            onClick={() => editingSessionId !== session.id && onSelect(session.id)}
            className={cn(
              "flex flex-col items-start gap-1 cursor-pointer",
              session.id === currentSessionId && "bg-accent"
            )}
          >
            {editingSessionId === session.id ? (
              // Inline edit mode
              <div className="flex items-center gap-1 w-full" onClick={(e) => e.stopPropagation()}>
                <Input
                  ref={inputRef}
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className="h-7 text-sm flex-1"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={handleSaveEdit}
                >
                  <Check className="h-3 w-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={handleCancelEdit}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            ) : (
              // Normal display mode
              <>
                <div className="flex items-center justify-between w-full">
                  <span className="font-medium truncate flex-1">{session.name}</span>
                  <div className="flex items-center gap-1">
                    {onRename && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 opacity-0 group-hover:opacity-100 hover:opacity-100"
                        onClick={(e) => handleStartEdit(e, session)}
                      >
                        <Pencil className="h-3 w-3" />
                      </Button>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {formatRelativeTime(session.updatedAt)}
                    </span>
                  </div>
                </div>
                <span className="text-xs text-muted-foreground">
                  {session.messageCount} messages
                </span>
              </>
            )}
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
