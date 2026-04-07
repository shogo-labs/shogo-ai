// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ChatTabBar — Cursor-style horizontal tab strip for open chat sessions.
 *
 * Renders scrollable tabs with truncated names, close buttons, a "New Chat"
 * button, and action icons. Placed below ProjectTopBar in the chat column.
 */

import React, { useRef, useCallback } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  Platform,
} from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import {
  X,
  Plus,
  History,
  MoreHorizontal,
} from 'lucide-react-native'

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
}

export function ChatTabBar({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewChat,
  onHistoryToggle,
  showHistory,
}: ChatTabBarProps) {
  const scrollRef = useRef<ScrollView>(null)

  const handleCloseTab = useCallback(
    (e: any, tabId: string) => {
      e.stopPropagation?.()
      onCloseTab(tabId)
    },
    [onCloseTab],
  )

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
        <Pressable
          className="h-7 w-7 items-center justify-center rounded-md active:bg-muted"
          accessibilityLabel="More options"
        >
          <MoreHorizontal size={14} className="text-muted-foreground" />
        </Pressable>
      </View>
    </View>
  )
}
