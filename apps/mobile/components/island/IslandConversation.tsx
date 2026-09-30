// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useMemo, useRef, useState } from "react"
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native"
import type { UIMessage } from "@ai-sdk/react"
import { ArrowDown } from "lucide-react-native"
import { TurnList } from "../chat/turns/TurnList"
import { MarkdownText } from "../chat/MarkdownText"

/** The island shows the tail of a chat; "Open in Shogo" has the rest. */
const MAX_MESSAGES = 30
const STICK_THRESHOLD_PX = 48

export function IslandConversation({
  messages,
  isStreaming,
  isLoading,
  liveReply,
  step,
  footer,
}: {
  messages: UIMessage[]
  isStreaming: boolean
  isLoading: boolean
  /** A mounted ChatPanel's in-flight reply, not yet persisted. */
  liveReply?: string
  step?: string
  footer?: React.ReactNode
}) {
  const scrollRef = useRef<ScrollView>(null)
  const atBottomRef = useRef(true)
  const [showJump, setShowJump] = useState(false)

  const visible = useMemo(() => messages.slice(-MAX_MESSAGES), [messages])
  const trimmed = messages.length > visible.length
  const showLiveTail = !!liveReply && visible[visible.length - 1]?.role !== "assistant"

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
    const atBottom = contentOffset.y + layoutMeasurement.height >= contentSize.height - STICK_THRESHOLD_PX
    atBottomRef.current = atBottom
    setShowJump(!atBottom)
  }, [])

  const onContentSizeChange = useCallback(() => {
    if (atBottomRef.current) scrollRef.current?.scrollToEnd({ animated: false })
  }, [])

  const jumpToLatest = useCallback(() => {
    atBottomRef.current = true
    setShowJump(false)
    scrollRef.current?.scrollToEnd({ animated: true })
  }, [])

  return (
    <View style={{ flexShrink: 1, minHeight: 0 }}>
      <ScrollView
        ref={scrollRef}
        onScroll={onScroll}
        scrollEventThrottle={32}
        onContentSizeChange={onContentSizeChange}
        style={{ flexGrow: 0, flexShrink: 1 }}
        contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8 }}
      >
        {trimmed ? (
          <Text className="mb-2 text-center text-[10px] text-muted-foreground">
            Showing the latest {MAX_MESSAGES} messages
          </Text>
        ) : null}
        {isLoading && messages.length === 0 ? (
          <View className="items-center py-6">
            <ActivityIndicator size="small" />
          </View>
        ) : messages.length === 0 && !liveReply ? (
          <Text className="py-6 text-center text-[12px] text-muted-foreground">
            No messages yet. Say hi.
          </Text>
        ) : (
          <TurnList messages={visible} isStreaming={isStreaming} />
        )}
        {showLiveTail ? (
          <View className="mt-3">
            <MarkdownText>{liveReply ?? ""}</MarkdownText>
          </View>
        ) : null}
        {isStreaming && step ? (
          <Text className="mt-2 text-[11px] text-muted-foreground" numberOfLines={1}>
            {step}
          </Text>
        ) : null}
        {footer ? <View className="mt-3 gap-2">{footer}</View> : null}
      </ScrollView>
      {showJump ? (
        <Pressable
          onPress={jumpToLatest}
          accessibilityLabel="Jump to latest"
          className="absolute bottom-2 self-center flex-row items-center gap-1 rounded-full bg-zinc-800 px-2.5 py-1"
        >
          <ArrowDown size={11} color="#e4e4e7" />
          <Text className="text-[10px] font-medium text-zinc-200">Latest</Text>
        </Pressable>
      ) : null}
    </View>
  )
}
