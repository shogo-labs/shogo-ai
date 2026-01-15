/**
 * ChatSessionPicker Component
 * Task: task-2-4-002 (chat-presentational-components)
 *
 * Renders a dropdown menu for selecting chat sessions.
 * Shows session name, message count, and relative time for each session.
 * Includes a "New Chat" option at the top, search, rename, and drag-and-drop reordering.
 */

import * as React from "react";
import { useState, useRef, useEffect, useMemo } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ChevronDown,
  MessageSquare,
  Plus,
  Pencil,
  Check,
  X,
  Search,
  GripVertical,
} from "lucide-react";

export interface ChatSession {
  id: string;
  name: string;
  messageCount: number;
  updatedAt: number;
}

/**
 * Mock data for development/testing - 20 chat sessions
 */
export const mockChatSessions: ChatSession[] = [
  { id: "session-1", name: "Feature Planning", messageCount: 45, updatedAt: Date.now() - 1000 * 60 * 5 },
  { id: "session-2", name: "Bug Fix Discussion", messageCount: 12, updatedAt: Date.now() - 1000 * 60 * 15 },
  { id: "session-3", name: "API Design Review", messageCount: 28, updatedAt: Date.now() - 1000 * 60 * 30 },
  { id: "session-4", name: "Database Schema", messageCount: 67, updatedAt: Date.now() - 1000 * 60 * 60 },
  { id: "session-5", name: "Auth Implementation", messageCount: 34, updatedAt: Date.now() - 1000 * 60 * 60 * 2 },
  { id: "session-6", name: "UI Component Library", messageCount: 89, updatedAt: Date.now() - 1000 * 60 * 60 * 3 },
  { id: "session-7", name: "Performance Optimization", messageCount: 23, updatedAt: Date.now() - 1000 * 60 * 60 * 5 },
  { id: "session-8", name: "Testing Strategy", messageCount: 41, updatedAt: Date.now() - 1000 * 60 * 60 * 8 },
  { id: "session-9", name: "Deployment Pipeline", messageCount: 56, updatedAt: Date.now() - 1000 * 60 * 60 * 12 },
  { id: "session-10", name: "Code Review Notes", messageCount: 18, updatedAt: Date.now() - 1000 * 60 * 60 * 24 },
  { id: "session-11", name: "Sprint Planning", messageCount: 72, updatedAt: Date.now() - 1000 * 60 * 60 * 24 * 2 },
  { id: "session-12", name: "Architecture Discussion", messageCount: 95, updatedAt: Date.now() - 1000 * 60 * 60 * 24 * 2 },
  { id: "session-13", name: "Error Handling", messageCount: 31, updatedAt: Date.now() - 1000 * 60 * 60 * 24 * 3 },
  { id: "session-14", name: "State Management", messageCount: 48, updatedAt: Date.now() - 1000 * 60 * 60 * 24 * 4 },
  { id: "session-15", name: "Refactoring Plan", messageCount: 27, updatedAt: Date.now() - 1000 * 60 * 60 * 24 * 5 },
  { id: "session-16", name: "Documentation", messageCount: 15, updatedAt: Date.now() - 1000 * 60 * 60 * 24 * 6 },
  { id: "session-17", name: "Security Audit", messageCount: 63, updatedAt: Date.now() - 1000 * 60 * 60 * 24 * 7 },
  { id: "session-18", name: "Migration Strategy", messageCount: 82, updatedAt: Date.now() - 1000 * 60 * 60 * 24 * 10 },
  { id: "session-19", name: "Logging Setup", messageCount: 19, updatedAt: Date.now() - 1000 * 60 * 60 * 24 * 12 },
  { id: "session-20", name: "Caching Layer", messageCount: 37, updatedAt: Date.now() - 1000 * 60 * 60 * 24 * 14 },
];

export interface ChatSessionPickerProps {
  sessions: ChatSession[];
  currentSessionId?: string;
  onSelect: (sessionId: string) => void;
  onCreate: () => void;
  /** Optional callback to rename a session */
  onRename?: (sessionId: string, newName: string) => void;
  /** Optional callback when sessions are reordered via drag-and-drop */
  onReorder?: (orderedIds: string[]) => void;
  /** Optional custom order (array of session IDs). If provided, uses this order instead of updatedAt sort */
  customOrder?: string[];
}

/**
 * Format timestamp as relative time (e.g., "5m ago", "1h ago", "1d ago")
 */
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  const minutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days > 0) {
    return `${days}d ago`;
  } else if (hours > 0) {
    return `${hours}h ago`;
  } else if (minutes > 0) {
    return `${minutes}m ago`;
  } else {
    return "just now";
  }
}

export function ChatSessionPicker({
  sessions,
  currentSessionId,
  onSelect,
  onCreate,
  onRename,
  onReorder,
  customOrder: externalCustomOrder,
}: ChatSessionPickerProps) {
  const currentSession = sessions.find((s) => s.id === currentSessionId);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [internalCustomOrder, setInternalCustomOrder] = useState<string[] | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Use external custom order if provided, otherwise use internal state
  const customOrder = externalCustomOrder ?? internalCustomOrder;

  // Sort sessions: use custom order if set, otherwise sort by updatedAt (most recent first)
  const sortedSessions = useMemo(() => {
    if (customOrder && customOrder.length > 0) {
      // Sort by custom order, put any new sessions at the end
      const orderMap = new Map(customOrder.map((id, index) => [id, index]));
      return [...sessions].sort((a, b) => {
        const aIndex = orderMap.get(a.id) ?? Infinity;
        const bIndex = orderMap.get(b.id) ?? Infinity;
        if (aIndex === Infinity && bIndex === Infinity) {
          return b.updatedAt - a.updatedAt;
        }
        return aIndex - bIndex;
      });
    }
    return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [sessions, customOrder]);

  // Filter sessions by search query
  const filteredSessions = useMemo(() => {
    if (!searchQuery.trim()) {
      return sortedSessions;
    }
    const query = searchQuery.toLowerCase();
    return sortedSessions.filter((session) =>
      session.name.toLowerCase().includes(query)
    );
  }, [sortedSessions, searchQuery]);

  // Focus search input when menu opens
  useEffect(() => {
    if (menuOpen && searchInputRef.current) {
      const timer = setTimeout(() => {
        searchInputRef.current?.focus();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [menuOpen]);

  // Focus rename input when editing starts
  useEffect(() => {
    if (editingSessionId && inputRef.current) {
      const timer = setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [editingSessionId]);

  // Clear search when menu closes
  useEffect(() => {
    if (!menuOpen) {
      setSearchQuery("");
    }
  }, [menuOpen]);

  const handleMenuOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && editingSessionId) {
      return;
    }

    setMenuOpen(nextOpen);
    if (!nextOpen) {
      setEditingSessionId(null);
    }
  };

  const handleSessionSelect = (sessionId: string) => {
    if (editingSessionId === sessionId) {
      return;
    }
    setEditingSessionId(null);
    onSelect(sessionId);
    setMenuOpen(false);
  };

  const handleStartEdit = (e: React.MouseEvent, session: ChatSession) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuOpen(true);
    setEditingSessionId(session.id);
    setEditValue(session.name);
  };

  const handleSaveEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (editingSessionId && editValue.trim() && onRename) {
      onRename(editingSessionId, editValue.trim());
    }
    setEditingSessionId(null);
  };

  const handleCreateClick = () => {
    setEditingSessionId(null);
    onCreate();
    setMenuOpen(false);
  };

  const handleCancelEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingSessionId(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Enter" && editingSessionId && editValue.trim() && onRename) {
      onRename(editingSessionId, editValue.trim());
      setEditingSessionId(null);
    } else if (e.key === "Escape") {
      setEditingSessionId(null);
    }
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    // Prevent Radix DropdownMenu from intercepting keypresses
    e.stopPropagation();
  };

  // Drag and drop handlers
  const handleDragStart = (e: React.DragEvent, sessionId: string) => {
    e.stopPropagation();
    setDraggedId(sessionId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", sessionId);
  };

  const handleDragOver = (e: React.DragEvent, sessionId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (draggedId && draggedId !== sessionId) {
      setDragOverId(sessionId);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverId(null);
  };

  const handleDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    e.stopPropagation();

    if (!draggedId || draggedId === targetId) {
      setDraggedId(null);
      setDragOverId(null);
      return;
    }

    // Calculate new order
    const currentOrder = sortedSessions.map((s) => s.id);
    const draggedIndex = currentOrder.indexOf(draggedId);
    const targetIndex = currentOrder.indexOf(targetId);

    if (draggedIndex === -1 || targetIndex === -1) {
      setDraggedId(null);
      setDragOverId(null);
      return;
    }

    // Remove dragged item and insert at target position
    const newOrder = [...currentOrder];
    newOrder.splice(draggedIndex, 1);
    newOrder.splice(targetIndex, 0, draggedId);

    // Update order
    if (onReorder) {
      onReorder(newOrder);
    } else {
      setInternalCustomOrder(newOrder);
    }

    setDraggedId(null);
    setDragOverId(null);
  };

  const handleDragEnd = () => {
    setDraggedId(null);
    setDragOverId(null);
  };

  return (
    <DropdownMenu open={menuOpen} onOpenChange={handleMenuOpenChange}>
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
        className="w-[280px] max-h-[400px] flex flex-col"
      >
        {/* New Chat Button */}
        <DropdownMenuItem
          data-testid="new-chat-option"
          onClick={handleCreateClick}
          className="cursor-pointer"
        >
          <Plus className="h-4 w-4 mr-2" />
          New Chat
        </DropdownMenuItem>

        {sessions.length > 0 && <DropdownMenuSeparator />}

        {/* Search Input */}
        {sessions.length > 0 && (
          <div className="px-2 py-1.5">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                ref={searchInputRef}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder="Search chats..."
                className="h-8 pl-7 text-sm"
              />
            </div>
          </div>
        )}

        {/* Sessions List */}
        <div className="overflow-y-auto flex-1">
          {filteredSessions.length === 0 && searchQuery && (
            <div className="px-2 py-3 text-sm text-muted-foreground text-center">
              No chats found
            </div>
          )}

          {filteredSessions.map((session) => (
            <DropdownMenuItem
              key={session.id}
              data-session-id={session.id}
              draggable={!editingSessionId && !searchQuery}
              onDragStart={(e) => handleDragStart(e, session.id)}
              onDragOver={(e) => handleDragOver(e, session.id)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, session.id)}
              onDragEnd={handleDragEnd}
              onSelect={(event) => {
                if (editingSessionId === session.id) {
                  event.preventDefault();
                  return;
                }
                handleSessionSelect(session.id);
              }}
              className={cn(
                "group flex flex-col items-start gap-1 cursor-pointer",
                session.id === currentSessionId && "bg-accent",
                draggedId === session.id && "opacity-50",
                dragOverId === session.id && "border-t-2 border-primary",
              )}
            >
              {editingSessionId === session.id ? (
                // Inline edit mode
                <div
                  className="flex items-center gap-1 w-full"
                  onClick={(e) => e.stopPropagation()}
                >
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
                    <div className="flex items-center gap-1 flex-1 min-w-0">
                      {/* Drag handle - only show when not searching */}
                      {!searchQuery && (
                        <GripVertical className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 cursor-grab shrink-0" />
                      )}
                      <span className="font-medium truncate">
                        {session.name}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
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
                  <span className="text-xs text-muted-foreground pl-4">
                    {session.messageCount} messages
                  </span>
                </>
              )}
            </DropdownMenuItem>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
