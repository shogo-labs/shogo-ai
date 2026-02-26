/**
 * MessageList Component (React Native)
 *
 * Renders a scrollable list of ChatMessage components with auto-scroll behavior.
 * Uses FlatList for efficient rendering of message lists.
 */

import { useRef, useEffect } from "react"
import { View, Text, FlatList, type ListRenderItemInfo } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { ChatMessage, type ChatMessageProps } from "./ChatMessage"

export interface MessageListProps {
  messages: ChatMessageProps["message"][]
  isLoading?: boolean
  className?: string
}

export function MessageList({ messages, isLoading = false, className }: MessageListProps) {
  const flatListRef = useRef<FlatList>(null)

  useEffect(() => {
    if (flatListRef.current && messages.length > 0) {
      flatListRef.current.scrollToEnd({ animated: true })
    }
  }, [messages])

  if (messages.length === 0 && !isLoading) {
    return (
      <View
        className={cn(
          "flex-1 items-center justify-center p-4",
          className
        )}
      >
        <Text className="text-sm text-gray-400 text-center">
          No messages yet
        </Text>
        <Text className="text-xs text-gray-400 mt-1 text-center">
          Start a conversation
        </Text>
      </View>
    )
  }

  const renderMessage = ({ item }: ListRenderItemInfo<ChatMessageProps["message"]>) => (
    <ChatMessage key={item.id} message={item} />
  )

  return (
    <View className={cn("flex-1", className)}>
      <FlatList
        ref={flatListRef}
        data={messages}
        renderItem={renderMessage}
        keyExtractor={(item) => item.id}
        contentContainerClassName="p-4 gap-4"
        onContentSizeChange={() => {
          flatListRef.current?.scrollToEnd({ animated: true })
        }}
        ListFooterComponent={
          isLoading ? (
            <View
              className="flex-row items-center gap-1 p-2"
              accessibilityLabel="Loading response"
            >
              <View className="w-2 h-2 rounded-full bg-gray-400" />
              <View className="w-2 h-2 rounded-full bg-gray-400" />
              <View className="w-2 h-2 rounded-full bg-gray-400" />
            </View>
          ) : null
        }
      />
    </View>
  )
}
