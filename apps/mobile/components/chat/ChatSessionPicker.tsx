// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ChatSessionPicker Component (React Native)
 *
 * Renders a popover for selecting chat sessions.
 * Shows session name, message count, and relative time for each session.
 * Includes a "New Chat" option and search.
 *
 * Note: Drag-and-drop reordering is omitted (not practical on mobile).
 * Rename uses a text input inline approach.
 */

import { useState, useMemo, useCallback, useEffect, useRef } from "react"
import {
  View,
  Text,
  Pressable,
  TextInput,
  FlatList,
  ActivityIndicator,
  useColorScheme,
  type ListRenderItemInfo,
} from "react-native"
import AsyncStorage from "@react-native-async-storage/async-storage"
import { LinearGradient } from "expo-linear-gradient"
import { cn } from "@shogo/shared-ui/primitives"
import {
  Popover,
  PopoverBackdrop,
  PopoverBody,
  PopoverContent,
} from "@/components/ui/popover"
import {
  Modal,
  ModalBackdrop,
  ModalContent,
  ModalBody,
  ModalCloseButton,
} from "@/components/ui/modal"
import {
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Plus,
  Pencil,
  Check,
  X,
  Search,
  Loader2,
  Trash2,
  Pin,
  PinOff,
  Archive,
  ArchiveRestore,
} from "lucide-react-native"

export interface ChatSession {
  id: string
  name: string
  messageCount: number
  updatedAt: number
  isPinned?: boolean
  isArchived?: boolean
}

export const mockChatSessions: ChatSession[] = [
  { id: "session-1", name: "Feature Planning", messageCount: 45, updatedAt: Date.now() - 1000 * 60 * 5 },
  { id: "session-2", name: "Bug Fix Discussion", messageCount: 12, updatedAt: Date.now() - 1000 * 60 * 15 },
  { id: "session-3", name: "API Design Review", messageCount: 28, updatedAt: Date.now() - 1000 * 60 * 30 },
  { id: "session-4", name: "Database Schema", messageCount: 67, updatedAt: Date.now() - 1000 * 60 * 60 },
  { id: "session-5", name: "Auth Implementation", messageCount: 34, updatedAt: Date.now() - 1000 * 60 * 60 * 2 },
]

export interface ChatSessionPickerProps {
  sessions: ChatSession[]
  currentSessionId?: string
  onSelect: (sessionId: string) => void
  onCreate: () => void
  onRename?: (sessionId: string, newName: string) => void
  /** Delete a chat session. When provided, each row gets a trash button. */
  onDelete?: (sessionId: string) => void
  onLoadMore?: () => void
  hasMore?: boolean
  isLoadingMore?: boolean
  /** Hide the "Chats" header row (search + new-chat buttons). Used in fullscreen mode where the top bar owns those controls. */
  hideHeader?: boolean
  /** Externally controlled search-modal open state. When provided, overrides internal state. */
  searchOpen?: boolean
  /** Called when the externally-controlled search modal should close. */
  onSearchClose?: () => void
  /** Set of session IDs whose stream is currently running. Renders an animated spinner on the row. */
  streamingSessionIds?: Set<string>
  /**
   * Set of session IDs whose stream has finished but whose row has not yet
   * been viewed by the user. Renders a static theme-colored dot.
   */
  completedSessionIds?: Set<string>
  /** Toggle the pinned-to-top flag for a session. */
  onTogglePin?: (sessionId: string, next: boolean) => void
  /** Toggle the archived flag for a session. */
  onToggleArchive?: (sessionId: string, next: boolean) => void
  /**
   * Project id used to scope the persisted Archived-section
   * expand/collapse state in AsyncStorage. When omitted the section
   * still works in-memory but its open/closed state won't survive a
   * reload.
   */
  projectId?: string
}

export function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp

  const minutes = Math.floor(diff / (1000 * 60))
  const hours = Math.floor(diff / (1000 * 60 * 60))
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))

  if (days > 0) return `${days}d ago`
  if (hours > 0) return `${hours}h ago`
  if (minutes > 0) return `${minutes}m ago`
  return "just now"
}

export function ChatSessionPicker({
  sessions,
  currentSessionId,
  onSelect,
  onCreate,
  onRename,
  onLoadMore,
  hasMore,
  isLoadingMore,
}: ChatSessionPickerProps) {
  const currentSession = sessions.find((s) => s.id === currentSessionId)
  const [isOpen, setIsOpen] = useState(false)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState("")
  const [searchQuery, setSearchQuery] = useState("")
  const [hoveredSessionId, setHoveredSessionId] = useState<string | null>(null)
  // Deferred clear so moving the cursor from the row onto a nested icon Pressable
  // (which fires the row's onHoverOut) doesn't briefly hide the icons.
  const clearHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setRowHover = (id: string) => {
    if (clearHoverTimerRef.current) {
      clearTimeout(clearHoverTimerRef.current)
      clearHoverTimerRef.current = null
    }
    setHoveredSessionId(id)
  }
  const scheduleClearRowHover = (id: string) => {
    if (clearHoverTimerRef.current) clearTimeout(clearHoverTimerRef.current)
    clearHoverTimerRef.current = setTimeout(() => {
      clearHoverTimerRef.current = null
      setHoveredSessionId((prev) => (prev === id ? null : prev))
    }, 0)
  }

  const sortedSessions = useMemo(() => {
    return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
  }, [sessions])

  const filteredSessions = useMemo(() => {
    if (!searchQuery.trim()) return sortedSessions
    const query = searchQuery.toLowerCase()
    return sortedSessions.filter((session) =>
      session.name.toLowerCase().includes(query)
    )
  }, [sortedSessions, searchQuery])

  const handleSessionSelect = (sessionId: string) => {
    if (editingSessionId === sessionId) return
    setEditingSessionId(null)
    onSelect(sessionId)
    setIsOpen(false)
  }

  const handleStartEdit = (session: ChatSession) => {
    setEditingSessionId(session.id)
    setEditValue(session.name)
  }

  const handleSaveEdit = () => {
    if (editingSessionId && editValue.trim() && onRename) {
      onRename(editingSessionId, editValue.trim())
    }
    setEditingSessionId(null)
  }

  const handleCancelEdit = () => {
    setEditingSessionId(null)
  }

  const handleCreateClick = () => {
    setEditingSessionId(null)
    onCreate()
    setIsOpen(false)
  }

  const handleEndReached = useCallback(() => {
    if (hasMore && !isLoadingMore && !searchQuery.trim()) {
      onLoadMore?.()
    }
  }, [hasMore, isLoadingMore, searchQuery, onLoadMore])

  const renderSession = ({ item: session }: ListRenderItemInfo<ChatSession>) => {
    const isEditing = editingSessionId === session.id
    const isCurrent = session.id === currentSessionId
    const isHovered = hoveredSessionId === session.id

    return (
      <Pressable
        onPress={() => handleSessionSelect(session.id)}
        onHoverIn={() => setRowHover(session.id)}
        onHoverOut={() => scheduleClearRowHover(session.id)}
        className={cn(
          "px-4 py-3 border-b border-gray-200/50 dark:border-gray-700/50 hover:bg-muted",
          isCurrent && "bg-primary/10"
        )}
      >
        {isEditing ? (
          <View className="flex-row items-center gap-2">
            <TextInput
              value={editValue}
              onChangeText={setEditValue}
              onSubmitEditing={handleSaveEdit}
              autoFocus
              className="flex-1 h-8 px-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-foreground"
            />
            <Pressable onPress={handleSaveEdit} className="p-1">
              <Check className="h-4 w-4 text-green-500" size={16} />
            </Pressable>
            <Pressable onPress={handleCancelEdit} className="p-1">
              <X className="h-4 w-4 text-red-500" size={16} />
            </Pressable>
          </View>
        ) : (
          <>
            <View className="flex-row items-center justify-between">
              <Text className="font-medium text-sm text-foreground flex-1" numberOfLines={1}>
                {session.name}
              </Text>
              <View className="flex-row items-center gap-2 shrink-0">
                {onRename && isHovered && (
                  <Pressable
                    onPress={() => handleStartEdit(session)}
                    onHoverIn={() => setRowHover(session.id)}
                    onHoverOut={() => scheduleClearRowHover(session.id)}
                    className="p-1"
                  >
                    <Pencil className="h-3 w-3 text-gray-400" size={12} />
                  </Pressable>
                )}
                <Text className="text-xs text-gray-400">
                  {formatRelativeTime(session.updatedAt)}
                </Text>
              </View>
            </View>
            {session.messageCount >= 0 && (
              <Text className="text-xs text-gray-400 mt-0.5">
                {session.messageCount} message{session.messageCount !== 1 ? 's' : ''}
              </Text>
            )}
          </>
        )}
      </Pressable>
    )
  }

  return (
    <Popover
      placement="bottom"
      size="full"
      isOpen={isOpen}
      onOpen={() => setIsOpen(true)}
      onClose={() => setIsOpen(false)}
      trigger={(triggerProps) => (
        <Pressable
          {...triggerProps}
          className="flex-row items-center gap-2 px-3 py-2"
        >
          <MessageSquare className="h-4 w-4 text-gray-400" size={16} />
          <Text className="text-sm text-foreground" numberOfLines={1}>
            {currentSession?.name ?? "Select Chat"}
          </Text>
          <ChevronDown className="h-4 w-4 text-gray-400 shrink-0" size={16} />
        </Pressable>
      )}
    >
      <PopoverBackdrop />
      <PopoverContent className="max-w-[320px] p-0 max-h-[400px]">
        <PopoverBody>
          {/* Header */}
          <View className="flex-row items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
            <Text className="text-base font-semibold text-foreground">Chat Sessions</Text>
          </View>

          {/* New Chat button */}
          <Pressable
            onPress={handleCreateClick}
            className="flex-row items-center gap-2 px-4 py-3 border-b border-gray-200/50 dark:border-gray-700/50"
          >
            <Plus className="h-4 w-4 text-primary" size={16} />
            <Text className="text-sm font-medium text-primary">New Chat</Text>
          </Pressable>

          {/* Search */}
          {sessions.length > 0 && (
            <View className="px-4 py-2">
              <View className="flex-row items-center gap-2 bg-gray-100 dark:bg-gray-800 rounded-md px-3 py-2">
                <Search className="h-3.5 w-3.5 text-gray-400" size={14} />
                <TextInput
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  placeholder="Search chats..."
                  placeholderTextColor="#9ca3af"
                  className="flex-1 text-sm text-foreground"
                />
              </View>
            </View>
          )}

          {/* Session list */}
          {filteredSessions.length === 0 && searchQuery ? (
            <View className="py-8 items-center">
              <Text className="text-sm text-gray-400">No chats found</Text>
            </View>
          ) : (
            <FlatList
              data={filteredSessions}
              renderItem={renderSession}
              keyExtractor={(item) => item.id}
              style={{ maxHeight: 240 }}
              onEndReached={handleEndReached}
              onEndReachedThreshold={0.5}
              ListFooterComponent={
                isLoadingMore ? (
                  <View className="py-3 items-center">
                    <ActivityIndicator size="small" />
                  </View>
                ) : null
              }
            />
          )}
        </PopoverBody>
      </PopoverContent>
    </Popover>
  )
}

/**
 * Always-visible sidebar variant of the session picker.
 * Renders the full session list inline (no popover) to fill its container.
 */
/** AsyncStorage key prefix for the per-project "Archived" section
 * expand/collapse state. Defaults to collapsed when no entry exists. */
const ARCHIVED_EXPANDED_STORAGE_PREFIX = "shogo:chatArchivedExpanded:"

/** A section header rendered inline in the same FlatList as the chat
 * rows. Headers stay non-pressable except for `Archived`, which toggles
 * `archivedExpanded`. */
type SidebarHeaderRow = {
  kind: "header"
  id: string
  label: string
  count?: number
  collapsible?: boolean
  expanded?: boolean
  onPress?: () => void
}

type SidebarSessionRow = {
  kind: "session"
  id: string
  session: ChatSession
}

type SidebarRow = SidebarHeaderRow | SidebarSessionRow

/** Returns the start-of-day for a given timestamp in the local
 * timezone. Used to decide whether a chat falls into the Today or
 * Yesterday bucket. */
function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Bucket label for a non-pinned, non-archived chat based on its last
 * activity timestamp. Buckets snap to local-day boundaries for Today
 * and Yesterday and to fixed millisecond windows past that so the
 * dividers don't shift mid-session. */
function bucketLabelFor(ts: number, now: number): "Today" | "Yesterday" | "Last 7 days" | "Last 30 days" | "Older" {
  const todayStart = startOfDay(now)
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000
  if (ts >= todayStart) return "Today"
  if (ts >= yesterdayStart) return "Yesterday"
  const diff = now - ts
  if (diff < 7 * 24 * 60 * 60 * 1000) return "Last 7 days"
  if (diff < 30 * 24 * 60 * 60 * 1000) return "Last 30 days"
  return "Older"
}

export function ChatSessionSidebar({
  sessions,
  currentSessionId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onTogglePin,
  onToggleArchive,
  onLoadMore,
  hasMore,
  isLoadingMore,
  hideHeader,
  searchOpen: externalSearchOpen,
  onSearchClose,
  streamingSessionIds,
  completedSessionIds,
  projectId,
}: ChatSessionPickerProps) {
  // Selected-row highlight uses a horizontal gradient that fades the primary
  // tint out toward the right edge — matches the sidebar wrapper's right-
  // edge fade so the selection stripe doesn't terminate in a hard line. The
  // primary token differs between themes (light: rgb(226,121,39), dark:
  // rgb(240,144,80) — see global.css), so we resolve the rgb here once.
  const colorScheme = useColorScheme()
  const primaryRgb = colorScheme === 'dark' ? '240,144,80' : '226,121,39'
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState("")
  const [internalSearchOpen, setInternalSearchOpen] = useState(false)
  const searchOpen = externalSearchOpen ?? internalSearchOpen
  const setSearchOpen = (open: boolean) => {
    if (externalSearchOpen !== undefined) {
      if (!open) onSearchClose?.()
    } else {
      setInternalSearchOpen(open)
    }
  }
  const [searchQuery, setSearchQuery] = useState("")

  // Archived section expand/collapse, persisted per-project so refresh
  // doesn't surprise users with their archive contents popping open.
  // Defaults to collapsed.
  const [archivedExpanded, setArchivedExpanded] = useState(false)
  const archivedHydratedRef = useRef(false)
  useEffect(() => {
    if (!projectId) {
      archivedHydratedRef.current = true
      return
    }
    let cancelled = false
    AsyncStorage.getItem(`${ARCHIVED_EXPANDED_STORAGE_PREFIX}${projectId}`)
      .then((raw) => {
        if (cancelled) return
        archivedHydratedRef.current = true
        if (raw === "1") setArchivedExpanded(true)
      })
      .catch(() => {
        archivedHydratedRef.current = true
      })
    return () => {
      cancelled = true
    }
  }, [projectId])
  useEffect(() => {
    // Skip the initial mount write before hydration so we don't clobber
    // a stored `1` with our default `false`.
    if (!projectId || !archivedHydratedRef.current) return
    AsyncStorage.setItem(
      `${ARCHIVED_EXPANDED_STORAGE_PREFIX}${projectId}`,
      archivedExpanded ? "1" : "0",
    ).catch(() => {})
  }, [projectId, archivedExpanded])

  const sortedSessions = useMemo(() => {
    return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
  }, [sessions])

  const filteredSessions = useMemo(() => {
    if (!searchQuery.trim()) return sortedSessions
    const query = searchQuery.toLowerCase()
    return sortedSessions.filter((session) =>
      session.name.toLowerCase().includes(query)
    )
  }, [sortedSessions, searchQuery])

  // Build the flat row list with section dividers interleaved. We use a
  // single FlatList of mixed rows (instead of SectionList) so the
  // existing `onEndReached` pagination keeps working unchanged.
  //
  // `now` is captured once per render; bucket boundaries snap to local
  // midnight so they don't shift while the user is interacting with
  // the list.
  const sidebarRows = useMemo<SidebarRow[]>(() => {
    const now = Date.now()
    const pinned: ChatSession[] = []
    const archived: ChatSession[] = []
    const bucketed: Record<"Today" | "Yesterday" | "Last 7 days" | "Last 30 days" | "Older", ChatSession[]> = {
      Today: [],
      Yesterday: [],
      "Last 7 days": [],
      "Last 30 days": [],
      Older: [],
    }
    for (const s of sortedSessions) {
      if (s.isArchived) {
        archived.push(s)
        continue
      }
      if (s.isPinned) {
        pinned.push(s)
        continue
      }
      bucketed[bucketLabelFor(s.updatedAt, now)].push(s)
    }

    const rows: SidebarRow[] = []
    const pushSection = (label: string, items: ChatSession[]) => {
      if (items.length === 0) return
      rows.push({ kind: "header", id: `__hdr:${label}`, label })
      for (const s of items) rows.push({ kind: "session", id: s.id, session: s })
    }

    pushSection("Pinned", pinned)
    pushSection("Today", bucketed.Today)
    pushSection("Yesterday", bucketed.Yesterday)
    pushSection("Last 7 days", bucketed["Last 7 days"])
    pushSection("Last 30 days", bucketed["Last 30 days"])
    pushSection("Older", bucketed.Older)

    if (archived.length > 0) {
      rows.push({
        kind: "header",
        id: "__hdr:Archived",
        label: "Archived",
        count: archived.length,
        collapsible: true,
        expanded: archivedExpanded,
        onPress: () => setArchivedExpanded((v) => !v),
      })
      if (archivedExpanded) {
        for (const s of archived) rows.push({ kind: "session", id: s.id, session: s })
      }
    }

    return rows
  }, [sortedSessions, archivedExpanded])

  const handleSessionSelect = (sessionId: string) => {
    if (editingSessionId === sessionId) return
    setEditingSessionId(null)
    onSelect(sessionId)
  }

  const handleSearchSelect = (sessionId: string) => {
    onSelect(sessionId)
    setSearchOpen(false)
    setSearchQuery("")
  }

  const handleStartEdit = (session: ChatSession) => {
    setEditingSessionId(session.id)
    setEditValue(session.name)
  }

  const handleSaveEdit = () => {
    if (editingSessionId && editValue.trim() && onRename) {
      onRename(editingSessionId, editValue.trim())
    }
    setEditingSessionId(null)
  }

  const handleCancelEdit = () => {
    setEditingSessionId(null)
  }

  const handleEndReached = useCallback(() => {
    if (hasMore && !isLoadingMore) {
      onLoadMore?.()
    }
  }, [hasMore, isLoadingMore, onLoadMore])

  const renderRow = ({ item }: ListRenderItemInfo<SidebarRow>) => {
    if (item.kind === "header") {
      const headerInner = (
        <View className="flex-row items-center gap-1 px-2 pt-3 pb-1">
          {item.collapsible ? (
            item.expanded ? (
              <ChevronDown size={10} className="text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight size={10} className="text-muted-foreground shrink-0" />
            )
          ) : null}
          <Text className="text-[10px] uppercase tracking-wide text-muted-foreground flex-1">
            {item.label}
          </Text>
          {typeof item.count === "number" && (
            <Text className="text-[10px] text-muted-foreground shrink-0">{item.count}</Text>
          )}
        </View>
      )
      if (item.collapsible && item.onPress) {
        return (
          <Pressable
            onPress={item.onPress}
            accessibilityLabel={`${item.expanded ? "Collapse" : "Expand"} ${item.label}`}
            className="hover:bg-muted"
          >
            {headerInner}
          </Pressable>
        )
      }
      return headerInner
    }

    const session = item.session
    const isEditing = editingSessionId === session.id
    const isCurrent = session.id === currentSessionId
    const isStreaming = streamingSessionIds?.has(session.id) ?? false
    // The "new activity" dot is only meaningful for non-current sessions; opening
    // the row clears it (parent layout handles the clearing on currentSessionId change).
    const isCompleted =
      !isCurrent && !isStreaming && (completedSessionIds?.has(session.id) ?? false)

    return (
      // `group` lets the action icons below show/hide purely via CSS
      // `group-hover:`. Driving icon visibility from React hover state caused
      // the icons to disappear the moment the cursor crossed onto one of them
      // (RN-Web fires the row's onHoverOut on entry into a nested Pressable,
      // racing with the icon's onHoverIn). CSS group-hover has no such race.
      <Pressable
        onPress={() => handleSessionSelect(session.id)}
        className={cn(
          "group relative px-2 py-1 hover:bg-muted",
        )}
      >
        {isCurrent && (
          // Selection highlight, faded toward the right so it lines up
          // visually with the sidebar's own right-edge fade. Rendered first
          // so siblings (text + icons) stack on top; pointerEvents="none"
          // keeps row taps reaching the parent Pressable.
          <LinearGradient
            colors={[`rgba(${primaryRgb},0.10)`, `rgba(${primaryRgb},0)`]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            pointerEvents="none"
            style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }}
          />
        )}
        {isEditing ? (
          <View className="flex-row items-center gap-2">
            <TextInput
              value={editValue}
              onChangeText={setEditValue}
              onSubmitEditing={handleSaveEdit}
              autoFocus
              className="flex-1 h-8 px-2 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-foreground"
            />
            <Pressable onPress={handleSaveEdit} className="p-1">
              <Check className="h-2 w-2 text-green-500" size={16} />
            </Pressable>
            <Pressable onPress={handleCancelEdit} className="p-1">
              <X className="h-2 w-2 text-red-500" size={16} />
            </Pressable>
          </View>
        ) : (
          <>
            <View className="flex-row items-center gap-2">
              {isStreaming ? (
                <Loader2
                  size={12}
                  className="text-primary animate-spin shrink-0"
                  aria-label="Chat running"
                />
              ) : isCompleted ? (
                <View
                  className="h-1.5 w-1.5 rounded-full bg-primary shrink-0"
                  accessibilityLabel="Chat has new activity"
                />
              ) : session.isPinned ? (
                <Pin size={10} className="text-muted-foreground shrink-0" />
              ) : null}
              <Text className="text-xs text-foreground flex-1" numberOfLines={1}>
                {session.name}
              </Text>
              {/*
                Action icons are always mounted; their visibility is purely
                CSS-driven via the parent row's `group` + `group-hover:flex`.
                This keeps them in the DOM continuously so hovering between
                them never tears down the cursor's hover target.
              */}
              <View className="hidden group-hover:flex flex-row items-center gap-1 shrink-0">
                {onTogglePin && (
                  <Pressable
                    onPress={() => onTogglePin(session.id, !session.isPinned)}
                    className="p-1 shrink-0"
                    accessibilityLabel={session.isPinned ? `Unpin ${session.name}` : `Pin ${session.name}`}
                  >
                    {session.isPinned ? (
                      <PinOff className="h-2 w-2 text-gray-400" size={6} />
                    ) : (
                      <Pin className="h-2 w-2 text-gray-400" size={6} />
                    )}
                  </Pressable>
                )}
                {onToggleArchive && (
                  <Pressable
                    onPress={() => onToggleArchive(session.id, !session.isArchived)}
                    className="p-1 shrink-0"
                    accessibilityLabel={session.isArchived ? `Unarchive ${session.name}` : `Archive ${session.name}`}
                  >
                    {session.isArchived ? (
                      <ArchiveRestore className="h-2 w-2 text-gray-400" size={6} />
                    ) : (
                      <Archive className="h-2 w-2 text-gray-400" size={6} />
                    )}
                  </Pressable>
                )}
                {onRename && (
                  <Pressable
                    onPress={() => handleStartEdit(session)}
                    className="p-1 shrink-0"
                    accessibilityLabel={`Rename ${session.name}`}
                  >
                    <Pencil className="h-2 w-2 text-gray-400" size={6} />
                  </Pressable>
                )}
                {onDelete && (
                  <Pressable
                    onPress={() => onDelete(session.id)}
                    className="p-1 shrink-0"
                    accessibilityLabel={`Delete ${session.name}`}
                  >
                    <Trash2 className="h-2 w-2 text-gray-400" size={6} />
                  </Pressable>
                )}
              </View>
            </View>
            {session.messageCount >= 0 && (
              <Text className="text-xs text-gray-400 mt-0.5">
                {session.messageCount} message{session.messageCount !== 1 ? 's' : ''}
              </Text>
            )}
          </>
        )}
      </Pressable>
    )
  }

  const renderSearchResult = ({ item: session }: ListRenderItemInfo<ChatSession>) => {
    const isCurrent = session.id === currentSessionId

    return (
      <Pressable
        onPress={() => handleSearchSelect(session.id)}
        className={cn(
          "flex-row items-center gap-3 px-4 py-3 hover:bg-muted",
          isCurrent && "bg-primary/10"
        )}
      >
        <MessageSquare className="text-muted-foreground shrink-0" size={16} />
        <Text className="font-medium text-sm text-foreground flex-1" numberOfLines={1}>
          {session.name}
        </Text>
      </Pressable>
    )
  }

  return (
    <View className="flex-1">
      {!hideHeader && (
        <View className="flex-row items-center justify-between px-4 py-3">
          <Text className="text-sm text-foreground">Chats</Text>
          <View className="flex-row items-center gap-1">
            {sessions.length > 0 && (
              <Pressable
                onPress={() => setSearchOpen(true)}
                className="h-7 w-7 items-center justify-center rounded-md active:bg-muted"
              >
                <Search className="text-muted-foreground" size={16} />
              </Pressable>
            )}
            <Pressable
              onPress={onCreate}
              className="h-7 w-7 items-center justify-center rounded-md active:bg-muted"
            >
              <Plus className="text-muted-foreground" size={16} />
            </Pressable>
          </View>
        </View>
      )}

      <FlatList
        data={sidebarRows}
        renderItem={renderRow}
        keyExtractor={(item) => item.id}
        className="flex-1"
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.5}
        ListFooterComponent={
          isLoadingMore ? (
            <View className="py-3 items-center">
              <ActivityIndicator size="small" />
            </View>
          ) : null
        }
      />

      <Modal
        isOpen={searchOpen}
        onClose={() => { setSearchOpen(false); setSearchQuery("") }}
        size="lg"
      >
        <ModalBackdrop />
        <ModalContent className="max-h-[70%]">
          <View className="flex-row items-center gap-3 px-4 py-3">
            <Search className="text-muted-foreground shrink-0" size={16} />
            <TextInput
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Search chats..."
              placeholderTextColor="#9ca3af"
              autoFocus
              className="flex-1 text-base text-foreground"
              style={{ outline: 'none' } as any}
            />
            <ModalCloseButton>
              <X className="text-muted-foreground" size={18} />
            </ModalCloseButton>
          </View>

          <ModalBody className="mt-0 mb-0 p-0">
            <Pressable
              onPress={() => { onCreate(); setSearchOpen(false); setSearchQuery("") }}
              className="flex-row items-center gap-3 px-4 py-3 bg-muted/50 hover:bg-muted"
            >
              <Plus className="text-primary shrink-0" size={16} />
              <Text className="text-sm font-medium text-primary">New chat</Text>
            </Pressable>

            {filteredSessions.length === 0 && searchQuery ? (
              <View className="py-8 items-center">
                <Text className="text-sm text-muted-foreground">No chats found</Text>
              </View>
            ) : (
              <FlatList
                data={filteredSessions}
                renderItem={renderSearchResult}
                keyExtractor={(item) => item.id}
                style={{ maxHeight: 400 }}
              />
            )}
          </ModalBody>
        </ModalContent>
      </Modal>
    </View>
  )
}
