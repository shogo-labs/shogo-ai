/**
 * ChatHeader Component
 * Task: task-2-4-002 (chat-presentational-components)
 *
 * Renders the chat panel header with session name, collapse toggle,
 * and loading indicator.
 */

import * as React from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { ChevronDown, Loader2 } from "lucide-react"

export interface ChatHeaderProps {
  sessionName: string
  isLoading?: boolean
  isCollapsed?: boolean
  onToggleCollapse: () => void
}

export function ChatHeader({
  sessionName,
  isLoading = false,
  isCollapsed = false,
  onToggleCollapse,
}: ChatHeaderProps) {
  return (
    <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card">
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <span className="font-medium text-sm truncate">{sessionName}</span>

        {isLoading && (
          <Loader2
            data-testid="loading-spinner"
            className="h-4 w-4 animate-spin text-muted-foreground shrink-0"
          />
        )}
      </div>

      <Button
        data-testid="collapse-button"
        variant="ghost"
        size="icon"
        onClick={onToggleCollapse}
        className="shrink-0"
        aria-label={isCollapsed ? "Expand chat" : "Collapse chat"}
      >
        <ChevronDown
          data-testid="collapse-icon"
          className={cn(
            "h-4 w-4 transition-transform duration-200",
            isCollapsed && "rotate-180"
          )}
        />
      </Button>
    </div>
  )
}
