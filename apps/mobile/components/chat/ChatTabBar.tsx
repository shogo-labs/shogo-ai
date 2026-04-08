// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ChatTabBar — Cursor-style horizontal tab strip for open chat sessions.
 *
 * Renders scrollable tabs with truncated names, close buttons, a "New Chat"
 * button, and action icons. Placed below ProjectTopBar in the chat column.
 */

import React, { useRef, useCallback, useState, useEffect } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  Platform,
  TextInput,
} from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import {
  X,
  Plus,
  History,
  MoreHorizontal,
  Pencil,
  Trash2,
  Search,
} from 'lucide-react-native'
import {
  Popover,
  PopoverBackdrop,
  PopoverContent,
  PopoverBody,
} from '@/components/ui/popover'
import {
  Modal,
  ModalBackdrop,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  ModalCloseButton,
} from '@/components/ui/modal'

export interface ChatTab {
  id: string
  name: string
}

export interface ChatTabBarProps {
  tabs: ChatTab[]
  activeTabId: string | null
  onSelectTab: (id: string) => void
  onCloseTab: (id: string) => void
  onNewChat: () => void
  /** Toggle chat-session history panel. Omit in fullscreen mode (sidebar provides history). */
  onHistoryToggle?: () => void
  showHistory?: boolean
  /** Set of tab IDs that currently have an active stream running. */
  streamingTabIds?: Set<string>
  /** Persist a new display name for the active session. */
  onRenameSession?: (sessionId: string, newName: string) => void | Promise<void>
  /** Delete the session on the server and remove it from open tabs (parent handles tab state). */
  onDeleteSession?: (sessionId: string) => void | Promise<void>
  /**
   * Open chat search (e.g. fullscreen layout where there is no history icon on this bar).
   * Omit when `onHistoryToggle` is provided so the menu is not redundant with the history control.
   */
  onSearchChats?: () => void
}

export function ChatTabBar({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewChat,
  onHistoryToggle,
  showHistory,
  streamingTabIds,
  onRenameSession,
  onDeleteSession,
  onSearchChats,
}: ChatTabBarProps) {
  const scrollRef = useRef<ScrollView>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameValue, setRenameValue] = useState('')

  const activeTab = activeTabId ? tabs.find((t) => t.id === activeTabId) : undefined
  const hasMoreMenuActions =
    Boolean(onSearchChats && !onHistoryToggle) ||
    Boolean(onRenameSession) ||
    Boolean(onDeleteSession)

  useEffect(() => {
    if (renameOpen && activeTab) {
      setRenameValue(activeTab.name)
    }
  }, [renameOpen, activeTab])

  const handleCloseTab = useCallback(
    (e: any, tabId: string) => {
      e.stopPropagation?.()
      onCloseTab(tabId)
    },
    [onCloseTab],
  )

  const closeMoreMenu = useCallback(() => setMoreOpen(false), [])

  const handleSaveRename = useCallback(async () => {
    const trimmed = renameValue.trim()
    if (!activeTabId || !trimmed || !onRenameSession) {
      setRenameOpen(false)
      return
    }
    try {
      await onRenameSession(activeTabId, trimmed)
    } finally {
      setRenameOpen(false)
    }
  }, [activeTabId, renameValue, onRenameSession])

  return (
    <View className="h-9 flex-row items-center bg-muted/50 dark:bg-black/20 border-b border-border">
      {/* Scrollable tab strip */}
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ alignItems: 'center' }}
        className="flex-1 min-w-0"
        keyboardShouldPersistTaps="handled"
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId
          const isStreaming = !isActive && streamingTabIds?.has(tab.id)
          return (
            <Pressable
              key={tab.id}
              onPress={() => onSelectTab(tab.id)}
              className={cn(
                'h-9 flex-row items-center gap-1 px-3 border-r border-border',
                isActive
                  ? 'bg-background'
                  : 'bg-transparent active:bg-muted',
              )}
              style={{ maxWidth: 180 }}
            >
              {isStreaming && (
                <View className="h-1.5 w-1.5 rounded-full bg-blue-500 shrink-0" />
              )}
              <Text
                className={cn(
                  'text-xs',
                  isActive
                    ? 'text-foreground font-medium'
                    : 'text-muted-foreground',
                )}
                numberOfLines={1}
                ellipsizeMode="tail"
                style={{ flexShrink: 1, minWidth: 0 }}
              >
                {tab.name}
              </Text>
              <Pressable
                onPress={(e) => handleCloseTab(e, tab.id)}
                className="h-4 w-4 items-center justify-center rounded-sm active:bg-muted ml-1 shrink-0"
                accessibilityLabel={`Close ${tab.name}`}
                {...(Platform.OS === 'web' ? { tabIndex: -1 } as any : {})}
              >
                <X
                  size={10}
                  className={cn(
                    isActive ? 'text-muted-foreground' : 'text-muted-foreground/50',
                  )}
                />
              </Pressable>
            </Pressable>
          )
        })}
      </ScrollView>

      {/* Right-side actions */}
      <View className="flex-row items-center gap-0.5 px-1.5 shrink-0">
        <Pressable
          onPress={onNewChat}
          className="h-7 w-7 items-center justify-center rounded-md active:bg-muted"
          accessibilityLabel="New chat"
        >
          <Plus size={14} className="text-muted-foreground" />
        </Pressable>
        {onHistoryToggle && (
          <Pressable
            onPress={onHistoryToggle}
            className={cn(
              'h-7 w-7 items-center justify-center rounded-md',
              showHistory ? 'bg-primary' : 'active:bg-muted',
            )}
            accessibilityLabel="Chat history"
          >
            <History
              size={14}
              className={cn(showHistory ? 'text-primary-foreground' : 'text-muted-foreground')}
            />
          </Pressable>
        )}
        {hasMoreMenuActions ? (
          <Popover
            placement="bottom right"
            size="sm"
            isOpen={moreOpen}
            onOpen={() => setMoreOpen(true)}
            onClose={closeMoreMenu}
            trigger={(triggerProps) => (
              <Pressable
                {...triggerProps}
                onPress={() => setMoreOpen((o) => !o)}
                className="h-7 w-7 items-center justify-center rounded-md active:bg-muted"
                accessibilityLabel="More options"
                accessibilityState={{ expanded: moreOpen }}
              >
                <MoreHorizontal size={14} className="text-muted-foreground" />
              </Pressable>
            )}
          >
            <PopoverBackdrop />
            <PopoverContent className="w-[200px] p-0">
              <PopoverBody className="py-1">
                {onSearchChats && !onHistoryToggle && (
                  <Pressable
                    onPress={() => {
                      closeMoreMenu()
                      onSearchChats()
                    }}
                    className="flex-row items-center gap-2 px-3 py-2 active:bg-muted"
                  >
                    <Search size={14} className="text-muted-foreground" />
                    <Text className="text-sm text-foreground">Search chats</Text>
                  </Pressable>
                )}
                {onRenameSession && (
                  <Pressable
                    onPress={() => {
                      closeMoreMenu()
                      setRenameOpen(true)
                    }}
                    disabled={!activeTabId}
                    className="flex-row items-center gap-2 px-3 py-2 active:bg-muted"
                  >
                    <Pencil size={14} className="text-muted-foreground" />
                    <Text className="text-sm text-foreground">Rename chat</Text>
                  </Pressable>
                )}
                {onDeleteSession && (
                  <Pressable
                    onPress={() => {
                      closeMoreMenu()
                      if (activeTabId) {
                        void onDeleteSession(activeTabId)
                      }
                    }}
                    disabled={!activeTabId}
                    className="flex-row items-center gap-2 px-3 py-2 active:bg-muted"
                  >
                    <Trash2 size={14} className="text-destructive" />
                    <Text className="text-sm text-destructive">Delete chat</Text>
                  </Pressable>
                )}
              </PopoverBody>
            </PopoverContent>
          </Popover>
        ) : (
          <Pressable
            className="h-7 w-7 items-center justify-center rounded-md opacity-50"
            accessibilityLabel="More options"
            disabled
          >
            <MoreHorizontal size={14} className="text-muted-foreground" />
          </Pressable>
        )}
      </View>

      <Modal
        isOpen={renameOpen}
        onClose={() => setRenameOpen(false)}
        size="sm"
      >
        <ModalBackdrop />
        <ModalContent className="p-0">
          <ModalHeader className="px-4 pt-4 pb-2 flex-row items-center justify-between border-b border-border">
            <Text className="text-base font-semibold text-foreground">Rename chat</Text>
            <ModalCloseButton>
              <X size={18} className="text-muted-foreground" />
            </ModalCloseButton>
          </ModalHeader>
          <ModalBody className="px-4 py-3">
            <TextInput
              value={renameValue}
              onChangeText={setRenameValue}
              placeholder="Chat name"
              placeholderTextColor="#9ca3af"
              autoFocus
              selectTextOnFocus
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
              style={
                Platform.OS === 'web'
                  ? ({ outlineStyle: 'none' } as object)
                  : undefined
              }
            />
          </ModalBody>
          <ModalFooter className="px-4 pb-4 flex-row justify-end gap-2 border-t border-border pt-3">
            <Pressable
              onPress={() => setRenameOpen(false)}
              className="rounded-md px-3 py-2 active:bg-muted"
            >
              <Text className="text-sm text-muted-foreground">Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => void handleSaveRename()}
              className="rounded-md bg-primary px-3 py-2 active:opacity-90"
            >
              <Text className="text-sm font-medium text-primary-foreground">Save</Text>
            </Pressable>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </View>
  )
}
