/**
 * ExpandTab Component
 * Task: task-2-4-002 (chat-presentational-components)
 *
 * Renders a vertical tab with "Chat" label and MessageSquare icon.
 * When collapsed, shows as a tab on the side that can be clicked to expand.
 */

import * as React from "react"
import { cn } from "@/lib/utils"
import { MessageSquare } from "lucide-react"

export interface ExpandTabProps {
  onExpand: () => void
  className?: string
}

export function ExpandTab({ onExpand, className }: ExpandTabProps) {
  return (
    <button
      onClick={onExpand}
      className={cn(
        // Vertical layout with writing mode
        "flex flex-col items-center gap-2 px-2 py-4",
        // Vertical text using writing mode
        "[writing-mode:vertical-rl] rotate-180",
        // Styling
        "bg-card border-l border-border rounded-l-lg",
        // Hover effects
        "hover:bg-accent hover:text-accent-foreground",
        // Transitions
        "transition-colors duration-200",
        // Cursor
        "cursor-pointer",
        className
      )}
      aria-label="Expand chat panel"
    >
      <MessageSquare
        data-testid="message-square-icon"
        className="h-4 w-4 shrink-0"
      />
      <span className="text-xs font-medium tracking-wider">Chat</span>
    </button>
  )
}
