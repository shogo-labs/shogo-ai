/**
 * HistoryPanel - Lovable.dev-style version history panel
 *
 * Shows a list of project versions/checkpoints that can be:
 * - Selected to preview
 * - Reverted to
 * - Bookmarked for easy access
 */

import { useState } from "react"
import {
  Bookmark,
  BookmarkCheck,
  RotateCcw,
  MoreHorizontal,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

export interface HistoryEntry {
  id: string
  title: string
  timestamp: Date
  isBookmarked?: boolean
  isCurrent?: boolean
}

export interface HistoryPanelProps {
  entries: HistoryEntry[]
  selectedEntryId?: string
  onSelect?: (entryId: string) => void
  onRevert?: (entryId: string) => void
  onBookmark?: (entryId: string, bookmarked: boolean) => void
  className?: string
}

function formatTimestamp(date: Date): string {
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return "Just now"
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

export function HistoryPanel({
  entries,
  selectedEntryId,
  onSelect,
  onRevert,
  onBookmark,
  className,
}: HistoryPanelProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  // Group entries by published status
  const publishedEntries = entries.filter((e) => e.isBookmarked)
  const unpublishedEntries = entries.filter((e) => !e.isBookmarked)

  return (
    <div className={cn("flex flex-col h-full", className)}>
      {/* Unpublished section */}
      <div className="px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground">
          Unpublished
        </span>
      </div>

      {/* History entries */}
      <div className="flex-1 overflow-y-auto px-2">
        {entries.length === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-muted-foreground">
            No history entries yet
          </div>
        ) : (
          <div className="space-y-1">
            {entries.map((entry) => {
              const isSelected = selectedEntryId === entry.id
              const isHovered = hoveredId === entry.id

              return (
                <div
                  key={entry.id}
                  className={cn(
                    "group relative rounded-md transition-colors",
                    isSelected
                      ? "bg-orange-500/20 text-orange-200"
                      : "hover:bg-muted/50"
                  )}
                  onMouseEnter={() => setHoveredId(entry.id)}
                  onMouseLeave={() => setHoveredId(null)}
                >
                  <button
                    className="w-full text-left px-3 py-2.5 rounded-md"
                    onClick={() => onSelect?.(entry.id)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={cn(
                          "text-sm font-medium truncate",
                          isSelected ? "text-orange-100" : "text-foreground"
                        )}
                      >
                        {entry.title}
                      </span>
                      <span
                        className={cn(
                          "text-xs whitespace-nowrap",
                          isSelected
                            ? "text-orange-200/70"
                            : "text-muted-foreground"
                        )}
                      >
                        {formatTimestamp(entry.timestamp)}
                      </span>
                    </div>
                  </button>

                  {/* Action buttons - show on hover */}
                  {(isHovered || isSelected) && (
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-foreground"
                        onClick={(e) => {
                          e.stopPropagation()
                          onBookmark?.(entry.id, !entry.isBookmarked)
                        }}
                        title={
                          entry.isBookmarked
                            ? "Remove bookmark"
                            : "Bookmark in history"
                        }
                      >
                        {entry.isBookmarked ? (
                          <BookmarkCheck className="h-3.5 w-3.5" />
                        ) : (
                          <Bookmark className="h-3.5 w-3.5" />
                        )}
                      </Button>

                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-foreground"
                        onClick={(e) => {
                          e.stopPropagation()
                          onRevert?.(entry.id)
                        }}
                        title="Revert to this version"
                        disabled={entry.isCurrent}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </Button>

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
                            onClick={() => onRevert?.(entry.id)}
                            disabled={entry.isCurrent}
                          >
                            Revert to this version
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() =>
                              onBookmark?.(entry.id, !entry.isBookmarked)
                            }
                          >
                            {entry.isBookmarked
                              ? "Remove bookmark"
                              : "Bookmark"}
                          </DropdownMenuItem>
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
