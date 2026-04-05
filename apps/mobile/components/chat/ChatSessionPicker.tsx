// SPDX-License-Identifier: AGPL-3.0-or-later
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

import { useState, useMemo, useCallback } from "react"
import {
  View,
  Text,
  Pressable,
  TextInput,
  FlatList,
  ActivityIndicator,
  type ListRenderItemInfo,
} from "react-native"
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
  MessageSquare,
  Plus,
  Pencil,
  Check,
  X,
  Search,
} from "lucide-react-native"

export interface ChatSession {
  id: string
  name: string
  messageCount: number
  updatedAt: number
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
  onLoadMore?: () => void
  hasMore?: boolean
  isLoadingMore?: boolean
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

    return (
      <Pressable
        onPress={() => handleSessionSelect(session.id)}
        className={cn(
          "px-4 py-3 border-b border-gray-200/50 dark:border-gray-700/50",
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
                {onRename && (
                  <Pressable onPress={() => handleStartEdit(session)} className="p-1">
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
export function ChatSessionSidebar({
  sessions,
  currentSessionId,
  onSelect,
  onCreate,
  onRename,
  onLoadMore,
  hasMore,
  isLoadingMore,
}: ChatSessionPickerProps) {
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState("")
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")

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

  const renderSession = ({ item: session }: ListRenderItemInfo<ChatSession>) => {
    const isEditing = editingSessionId === session.id
    const isCurrent = session.id === currentSessionId

    return (
      <Pressable
        onPress={() => handleSessionSelect(session.id)}
        className={cn(
          "px-4 py-3",
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
              {onRename && (
                <Pressable onPress={() => handleStartEdit(session)} className="p-1 shrink-0">
                  <Pencil className="h-3 w-3 text-gray-400" size={12} />
                </Pressable>
              )}
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
          "flex-row items-center gap-3 px-4 py-3",
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
      <View className="flex-row items-center justify-between px-4 py-3">
        <Text className="text-sm font-semibold text-foreground">Chat History</Text>
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

      <FlatList
        data={sortedSessions}
        renderItem={renderSession}
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
              className="flex-row items-center gap-3 px-4 py-3 bg-muted/50"
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
