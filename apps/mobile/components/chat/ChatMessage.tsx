// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ChatMessage Component (React Native)
 *
 * Renders user/assistant chat messages with role-based styling.
 * User messages are right-aligned, assistant messages are left-aligned.
 * Supports streaming state with typing indicator.
 */

import { View, Text } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { MarkdownText } from "./MarkdownText"
import { analyzeContent } from "./long-text-utils"
import { LongTextPreviewCard } from "./LongTextPreviewCard"

export interface ChatMessageProps {
  message: {
    id: string
    role: "user" | "assistant"
    content: string
  }
  isStreaming?: boolean
}

export function ChatMessage({ message, isStreaming = false }: ChatMessageProps) {
  const isUser = message.role === "user"
  const contentInfo = message.content ? analyzeContent(message.content) : null
  const isLongText = contentInfo?.isLong ?? false

  return (
    <View
      className={cn(
        "flex-row w-full",
        isUser ? "justify-end" : "justify-start"
      )}
    >
      <View
        className={cn(
          "max-w-[80%] rounded-lg px-4 py-2",
          isUser
            ? "bg-secondary dark:bg-secondary ml-auto"
            : "bg-gray-100 dark:bg-gray-800 mr-auto"
        )}
      >
        {isLongText && !isStreaming ? (
          <LongTextPreviewCard
            text={message.content}
            title={isUser ? "Your Message" : "Response"}
          />
        ) : isUser ? (
          <Text
            className={cn("text-sm text-foreground")}
          >
            {message.content}
          </Text>
        ) : (
          <MarkdownText
            className="text-sm text-foreground prose-sm"
            isStreaming={isStreaming}
          >
            {message.content}
          </MarkdownText>
        )}

        {isStreaming && !isUser && (
          <View
            className="flex-row items-center gap-1 mt-2"
            accessibilityLabel="Assistant is typing"
          >
            <View className="w-2 h-2 rounded-full bg-foreground/50" />
            <View className="w-2 h-2 rounded-full bg-foreground/50" />
            <View className="w-2 h-2 rounded-full bg-foreground/50" />
          </View>
        )}
      </View>
    </View>
  )
}
