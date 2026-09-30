// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useMemo } from 'react'
import { ActivityIndicator, FlatList, Text, View } from 'react-native'
import type { ChatMessage } from '../../lib/team-chat-api'
import { startsGroup, type MentionNames, type TimelineState } from '../../lib/team-chat-state'
import { MessageRow, type MessageRowProps } from './MessageRow'

type RowHandlers = Omit<MessageRowProps, 'message' | 'grouped' | 'me' | 'names' | 'streaming' | 'canManage' | 'inThread'>

export interface MessageListProps extends RowHandlers {
  state: TimelineState
  loading: boolean
  me: string | null
  names: MentionNames
  canManage: boolean
  inThread?: boolean
  emptyText?: string
  header?: React.ReactElement | null
  onLoadOlder?: () => void
}

/** Newest-at-bottom list (an inverted FlatList, so it stays pinned to the latest message). */
export function MessageList({ state, loading, me, names, canManage, inThread, emptyText, header, onLoadOlder, ...handlers }: MessageListProps) {
  const rows = useMemo(() => {
    const out: Array<{ message: ChatMessage; grouped: boolean }> = []
    state.messages.forEach((m, i) => out.push({ message: m, grouped: !startsGroup(state.messages[i - 1], m) }))
    return out.reverse()
  }, [state.messages])

  if (loading && !state.messages.length) {
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator />
      </View>
    )
  }

  return (
    <FlatList
      inverted
      data={rows}
      keyExtractor={(row) => row.message.id}
      renderItem={({ item }) => (
        <MessageRow
          message={item.message}
          grouped={item.grouped}
          me={me}
          names={names}
          streaming={state.streaming[item.message.id]}
          canManage={canManage}
          inThread={inThread}
          {...handlers}
        />
      )}
      onEndReached={onLoadOlder}
      onEndReachedThreshold={0.4}
      contentContainerStyle={{ paddingVertical: 8, flexGrow: 1 }}
      ListFooterComponent={
        <View>
          {state.hasMoreOlder && onLoadOlder ? (
            <View className="items-center py-3">
              <ActivityIndicator size="small" />
            </View>
          ) : (
            header ?? null
          )}
        </View>
      }
      ListEmptyComponent={
        <View className="flex-1 items-center justify-center px-8 py-16" style={{ transform: [{ scaleY: -1 }] }}>
          <Text className="text-center text-sm text-muted-foreground">{emptyText ?? 'No messages yet.'}</Text>
        </View>
      }
      keyboardShouldPersistTaps="handled"
    />
  )
}
