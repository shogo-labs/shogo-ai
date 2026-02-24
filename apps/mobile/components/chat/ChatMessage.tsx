/**
 * ChatMessage Component (React Native)
 *
 * Renders user/assistant chat messages with role-based styling.
 * User messages are right-aligned, assistant messages are left-aligned.
 * Supports streaming state with typing indicator.
 */

import { View, Text } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"

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
            ? "bg-primary ml-auto"
            : "bg-gray-100 dark:bg-gray-800 mr-auto"
        )}
      >
        <Text
          className={cn(
            "text-sm",
            isUser ? "text-primary-foreground" : "text-foreground"
          )}
        >
          {message.content}
        </Text>

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
