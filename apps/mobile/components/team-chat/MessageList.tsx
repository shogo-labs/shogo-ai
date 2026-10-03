// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useCallback, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, Platform, Pressable, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import { ArrowDown } from 'lucide-react-native'
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
  /** Called when the reader is back at the latest message and many messages are loaded. */
  onTrim?: () => void
  trimThreshold?: number
}

type Row = { message: ChatMessage; grouped: boolean }

const JUMP_OFFSET = 800
const AT_LATEST_OFFSET = 40

/** Newest-at-bottom list (an inverted FlatList, so it stays pinned to the latest message). */
export function MessageList({
  state, loading, me, names, canManage, inThread, emptyText, header, onLoadOlder, onTrim, trimThreshold = Infinity, ...handlers
}: MessageListProps) {
  const rows = useMemo(() => {
    const out: Row[] = []
    state.messages.forEach((m, i) => out.push({ message: m, grouped: !startsGroup(state.messages[i - 1], m) }))
    return out.reverse()
  }, [state.messages])

  const listRef = useRef<FlatList<Row>>(null)
  const [awayFromLatest, setAwayFromLatest] = useState(false)
  const rowCount = useRef(0)
  rowCount.current = rows.length
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const offset = e.nativeEvent.contentOffset.y
    setAwayFromLatest(offset > JUMP_OFFSET)
    if (offset < AT_LATEST_OFFSET && rowCount.current > trimThreshold) onTrim?.()
  }, [onTrim, trimThreshold])

  const handlersRef = useRef(handlers)
  handlersRef.current = handlers
  const shape = Object.entries(handlers)
    .map(([k, v]) => `${k}:${typeof v === 'function' ? 'fn' : String(v)}`)
    .join('|')
  /** Same props as `handlers`, but callbacks keep their identity so memoized rows don't re-render. */
  const rowProps = useMemo(() => {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(handlersRef.current)) {
      out[key] = typeof value === 'function'
        ? (...args: unknown[]) => (handlersRef.current as Record<string, any>)[key]?.(...args)
        : value
    }
    return out as RowHandlers
  }, [shape])
  const renderItem = useCallback(({ item }: { item: Row }) => (
    <MessageRow
      message={item.message}
      grouped={item.grouped}
      me={me}
      names={names}
      streaming={state.streaming[item.message.id]}
      canManage={canManage}
      inThread={inThread}
      {...rowProps}
    />
  ), [me, names, state.streaming, canManage, inThread, rowProps])

  if (loading && !state.messages.length) {
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator />
      </View>
    )
  }

  return (
    <View className="flex-1">
      <FlatList
        ref={listRef}
        inverted
        data={rows}
        keyExtractor={(row) => row.message.id}
        renderItem={renderItem}
        initialNumToRender={20}
        maxToRenderPerBatch={12}
        updateCellsBatchingPeriod={40}
        windowSize={9}
        removeClippedSubviews={Platform.OS === 'android'}
        onScroll={onScroll}
        scrollEventThrottle={100}
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
      {awayFromLatest ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Jump to latest message"
          onPress={() => listRef.current?.scrollToOffset({ offset: 0, animated: true })}
          className="absolute bottom-3 self-center flex-row items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 shadow-sm active:bg-muted web:hover:bg-muted"
        >
          <ArrowDown size={12} className="text-foreground" />
          <Text className="text-xs font-medium text-foreground">Jump to latest</Text>
        </Pressable>
      ) : null}
    </View>
  )
}
