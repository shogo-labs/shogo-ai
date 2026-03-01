/**
 * ChatHeader Component
 * Task: task-2-4-002 (chat-presentational-components)
 *
 * Renders the chat panel header with session name, collapse toggle,
 * and loading indicator.
 */

import * as React from "react"
import { View, Text, Pressable } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { ChevronDown, Loader2 } from "lucide-react-native"

export interface ChatHeaderProps {
  sessionName: string
  isLoading?: boolean
  isCollapsed?: boolean
  onToggleCollapse: () => void
}

export function ChatHeader({
  sessionName,
  isLoading = false,
  isCollapsed = false,
  onToggleCollapse,
}: ChatHeaderProps) {
  return (
    <View className="flex-row items-center justify-between px-4 py-2 border-b border-border bg-card">
      <View className="flex-row items-center gap-2 flex-1 min-w-0">
        <Text className="font-medium text-sm" numberOfLines={1}>
          {sessionName}
        </Text>

        {isLoading && (
          <Loader2
            className="h-4 w-4 animate-spin text-muted-foreground shrink-0"
          />
        )}
      </View>

      <Pressable
        onPress={onToggleCollapse}
        className="shrink-0 p-2 rounded-md active:bg-accent"
        accessibilityLabel={isCollapsed ? "Expand chat" : "Collapse chat"}
      >
        <ChevronDown
          className={cn(
            "h-4 w-4 text-foreground",
            isCollapsed && "rotate-180"
          )}
        />
      </Pressable>
    </View>
  )
}
