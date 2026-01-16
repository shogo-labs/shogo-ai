/**
 * ChatSessionsPanel - Panel to view and manage chat sessions
 *
 * Shows a list of chat sessions that can be:
 * - Selected to switch to
 * - Created (new chat)
 * - Renamed
 */

import { useState } from "react"
import {
  Plus,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

export interface ChatSessionItem {
  id: string
  name: string
  messageCount?: number
  updatedAt?: number | Date
}

export interface ChatSessionsPanelProps {
  sessions: ChatSessionItem[]
  currentSessionId?: string
  onSelect?: (sessionId: string) => void
  onCreate?: () => void
  onRename?: (sessionId: string, newName: string) => void
  onDelete?: (sessionId: string) => void
  className?: string
}

function formatTimestamp(date: Date | number | undefined): string {
  if (!date) return ""
  const d = typeof date === "number" ? new Date(date) : date
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return "Just now"
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`

  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  })
}

export function ChatSessionsPanel({
  sessions,
  currentSessionId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  className,
}: ChatSessionsPanelProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  return (
    <div className={cn("flex flex-col h-full", className)}>
      {/* Header with New Chat button */}
      <div className="px-3 py-2 border-b border-border/50">
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start gap-2 h-8"
          onClick={onCreate}
        >
          <Plus className="h-3.5 w-3.5" />
          New Chat
        </Button>
      </div>

      {/* Sessions list */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {sessions.length === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-muted-foreground">
            No chat sessions yet
          </div>
        ) : (
          <div className="space-y-1">
            {sessions.map((session) => {
              const isSelected = currentSessionId === session.id
              const isHovered = hoveredId === session.id

              return (
                <div
                  key={session.id}
                  className={cn(
                    "group relative rounded-md transition-colors",
                    isSelected
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-muted/50"
                  )}
                  onMouseEnter={() => setHoveredId(session.id)}
                  onMouseLeave={() => setHoveredId(null)}
                >
                  <button
                    className="w-full text-left px-3 py-2 rounded-md flex items-center gap-2"
                    onClick={() => onSelect?.(session.id)}
                  >
                    <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">
                        {session.name || "Untitled Chat"}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        {session.messageCount !== undefined && (
                          <span>{session.messageCount} messages</span>
                        )}
                        {session.updatedAt && (
                          <span>• {formatTimestamp(session.updatedAt)}</span>
                        )}
                      </div>
                    </div>
                  </button>

                  {/* Action menu - show on hover */}
                  {(isHovered || isSelected) && (
                    <div className="absolute right-2 top-1/2 -translate-y-1/2">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-muted-foreground hover:text-foreground"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <MoreHorizontal className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => {
                              const newName = prompt("Enter new name:", session.name)
                              if (newName && newName !== session.name) {
                                onRename?.(session.id, newName)
                              }
                            }}
                          >
                            <Pencil className="h-4 w-4 mr-2" />
                            Rename
                          </DropdownMenuItem>
                          {onDelete && (
                            <DropdownMenuItem
                              className="text-destructive"
                              onClick={() => onDelete(session.id)}
                            >
                              <Trash2 className="h-4 w-4 mr-2" />
                              Delete
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
