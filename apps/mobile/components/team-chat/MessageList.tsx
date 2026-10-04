// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, Platform, Pressable, Text, View, type NativeScrollEvent, type NativeSyntheticEvent, type ViewToken } from 'react-native'
import { ArrowDown, ArrowUp, X } from 'lucide-react-native'
import type { ChatMessage } from '../../lib/team-chat-api'
import { firstUnreadIndex, startsGroup, type MentionNames, type TimelineState } from '../../lib/team-chat-state'
import { foldStatusRuns, type TimelineItem } from '../../lib/team-chat-kinds'
import { MessageRow, type MessageRowProps } from './MessageRow'
import { StatusRunRow } from './AgentStatus'

type RowHandlers = Omit<MessageRowProps, 'message' | 'grouped' | 'me' | 'names' | 'streaming' | 'canManage' | 'inThread' | 'highlighted'>

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
  /** Messages after this seq are new to the reader; a "New" line marks where they start. */
  unreadAfterSeq?: number | null
  /** Messages after this seq arrived while reading, so they aren't marked new. */
  unreadUpToSeq?: number
  /** The first unread message is older than what's loaded. */
  unreadNotLoaded?: boolean
  /** Load back to the first unread message. */
  onRevealUnread?: () => void
  /** Scroll to and emphasize this message once it's loaded. */
  highlightId?: string | null
  /** Space taken by chrome floating over the list (header above, composer below). */
  insets?: { top: number; bottom: number }
}

type Row = TimelineItem & { grouped: boolean }

const JUMP_OFFSET = 800
const AT_LATEST_OFFSET = 40
/** Open at the "New" line instead of the latest message when more than this many rows are unread. */
const OPEN_AT_UNREAD_ROWS = 8
const NO_INSETS = { top: 0, bottom: 0 }

/** Newest-at-bottom list (an inverted FlatList, so it stays pinned to the latest message). */
export function MessageList({
  state, loading, me, names, canManage, inThread, emptyText, header, onLoadOlder, onTrim, trimThreshold = Infinity,
  unreadAfterSeq = null, unreadUpToSeq = Infinity, unreadNotLoaded = false, onRevealUnread, highlightId = null, insets = NO_INSETS, ...handlers
}: MessageListProps) {
  const rows = useMemo(() => {
    const items = foldStatusRuns(state.messages)
    const out: Row[] = items.map((item, i) => ({ ...item, grouped: !startsGroup(items[i - 1]?.message, item.message) }))
    return out.reverse()
  }, [state.messages])
  const unreadIdx = useMemo(
    () => (unreadAfterSeq === null ? -1 : firstUnreadIndex(state.messages, unreadAfterSeq, me, unreadUpToSeq)),
    [state.messages, unreadAfterSeq, unreadUpToSeq, me],
  )
  const unreadMessageId = unreadIdx >= 0 ? state.messages[unreadIdx]!.id : null
  // The "New" line sits on the row showing that message, which may be a folded run.
  const unreadRow = unreadMessageId
    ? rows.findIndex((r) => r.message.id === unreadMessageId || r.folded.some((m) => m.id === unreadMessageId))
    : -1
  const firstUnreadId = unreadRow >= 0 ? rows[unreadRow]!.message.id : null
  const unreadCount = unreadIdx >= 0
    ? state.messages.slice(unreadIdx).filter((m) => !m.pending && m.authorUserId !== me).length
    : 0

  const listRef = useRef<FlatList<Row>>(null)
  const scrollToRow = useCallback((index: number, viewPosition: number) => {
    listRef.current?.scrollToIndex({ index, viewPosition, animated: false })
  }, [])
  const onScrollToIndexFailed = useCallback((info: { index: number; averageItemLength: number }) => {
    listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false })
    setTimeout(() => listRef.current?.scrollToIndex({ index: info.index, viewPosition: 0.5, animated: false }), 80)
  }, [])

  // In an inverted list, viewPosition 1 puts a row at the top of the screen.
  const openedAtUnread = useRef(false)
  useEffect(() => {
    if (openedAtUnread.current || loading || !rows.length) return
    openedAtUnread.current = true
    if (!highlightId && unreadRow >= OPEN_AT_UNREAD_ROWS) requestAnimationFrame(() => scrollToRow(unreadRow, 0.9))
  }, [loading, rows.length, highlightId, unreadRow, scrollToRow])

  const highlightRow = highlightId ? rows.findIndex((r) => r.message.id === highlightId || r.folded.some((m) => m.id === highlightId)) : -1
  const scrolledToHighlight = useRef<string | null>(null)
  useEffect(() => {
    if (!highlightId || highlightRow < 0 || scrolledToHighlight.current === highlightId) return
    scrolledToHighlight.current = highlightId
    requestAnimationFrame(() => scrollToRow(highlightRow, 0.5))
  }, [highlightId, highlightRow, scrollToRow])

  const [furthestVisible, setFurthestVisible] = useState(-1)
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    let max = -1
    for (const v of viewableItems) if (typeof v.index === 'number' && v.index > max) max = v.index
    setFurthestVisible(max)
  }).current
  const [unreadPillDismissed, setUnreadPillDismissed] = useState(false)
  const showUnreadPill = !inThread && !unreadPillDismissed && (
    unreadNotLoaded || (unreadRow >= 0 && furthestVisible >= 0 && furthestVisible < unreadRow)
  )
  const jumpToUnread = () => {
    if (unreadNotLoaded) onRevealUnread?.()
    else if (unreadRow >= 0) scrollToRow(unreadRow, 0.9)
  }
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
  const renderItem = useCallback(({ item }: { item: Row }) => {
    const row = item.folded.length ? (
      <StatusRunRow latest={item.message} folded={item.folded} onOpenThread={inThread ? undefined : rowProps.onReply} />
    ) : (
      <MessageRow
        message={item.message}
        grouped={item.grouped && item.message.id !== firstUnreadId}
        me={me}
        names={names}
        streaming={state.streaming[item.message.id]}
        canManage={canManage}
        inThread={inThread}
        highlighted={item.message.id === highlightId}
        {...rowProps}
      />
    )
    if (item.message.id !== firstUnreadId) return row
    return (
      <View>
        <View className="flex-row items-center gap-2 px-4 pt-2" testID="new-messages-line" accessibilityLabel="New messages">
          <View className="h-px flex-1 bg-red-500/60" />
          <Text className="text-[11px] font-semibold text-red-500">New</Text>
        </View>
        {row}
      </View>
    )
  }, [me, names, state.streaming, canManage, inThread, rowProps, firstUnreadId, highlightId])

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
        onScrollToIndexFailed={onScrollToIndexFailed}
        onViewableItemsChanged={onViewableItemsChanged}
        extraData={`${firstUnreadId}:${highlightId}`}
        onEndReached={onLoadOlder}
        onEndReachedThreshold={0.4}
        // Inverted: the container's top padding is the visual bottom.
        contentContainerStyle={{ paddingTop: 8 + insets.bottom, paddingBottom: 8 + insets.top, flexGrow: 1 }}
        scrollIndicatorInsets={{ top: insets.bottom, bottom: insets.top }}
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
      {showUnreadPill ? (
        <View
          className="absolute self-center flex-row items-center overflow-hidden rounded-full bg-red-500 shadow-sm"
          style={{ top: insets.top + 8 }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Jump to first unread message"
            onPress={jumpToUnread}
            className="flex-row items-center gap-1.5 py-1.5 pl-3 pr-2 active:opacity-80"
          >
            <ArrowUp size={12} color="#fff" />
            <Text className="text-xs font-medium text-white">
              {unreadNotLoaded || unreadCount === 0 ? 'Jump to first unread' : `${unreadCount} new ${unreadCount === 1 ? 'message' : 'messages'}`}
            </Text>
          </Pressable>
          <Pressable accessibilityLabel="Dismiss" onPress={() => setUnreadPillDismissed(true)} className="py-1.5 pl-1 pr-2.5 active:opacity-80">
            <X size={12} color="#fff" />
          </Pressable>
        </View>
      ) : null}
      {awayFromLatest ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Jump to latest message"
          onPress={() => listRef.current?.scrollToOffset({ offset: 0, animated: true })}
          className="absolute self-center flex-row items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 shadow-sm active:bg-muted web:hover:bg-muted"
          style={{ bottom: insets.bottom + 12 }}
        >
          <ArrowDown size={12} className="text-foreground" />
          <Text className="text-xs font-medium text-foreground">Jump to latest</Text>
        </Pressable>
      ) : null}
    </View>
  )
}
