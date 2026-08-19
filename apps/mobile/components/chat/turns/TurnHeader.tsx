// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * TurnHeader Component (React Native)
 *
 * Shows role, timestamp, and phase badge for a conversation turn.
 */

import { View, Text, Platform } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { User, Bot } from "lucide-react-native"
import { usePhaseColor } from "@/hooks/usePhaseColor"

export interface TurnHeaderProps {
  role: "user" | "assistant"
  timestamp?: Date
  phase?: string | null
  className?: string
}

export function TurnHeader({
  role,
  timestamp,
  phase,
  className,
}: TurnHeaderProps) {
  const colors = usePhaseColor(phase || "")
  const isNative = Platform.OS !== "web"

  const formattedTime = timestamp
    ? timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null

  return (
    <View className={cn("flex-row items-center", isNative ? "min-h-7 gap-2 mb-1" : "gap-1.5 mb-0.5", className)}>
      {role === "user" ? (
        <View className={cn("rounded-full bg-primary/10 items-center justify-center", isNative ? "w-6 h-6" : "w-4 h-4")}>
          <User className="text-primary" size={isNative ? 16 : 10} />
        </View>
      ) : (
        <View className={cn("rounded-full bg-muted items-center justify-center", isNative ? "w-6 h-6" : "w-4 h-4")}>
          <Bot className="text-muted-foreground" size={isNative ? 16 : 10} />
        </View>
      )}

      <Text
        className={cn(
          isNative ? "text-sm font-medium" : "text-[10px] font-medium",
          role === "user" ? "text-primary" : "text-muted-foreground"
        )}
      >
        {role === "user" ? "You" : "Shogo"}
      </Text>

      {formattedTime && (
        <Text className={cn("text-muted-foreground/60 font-mono", isNative ? "text-xs" : "text-[9px]")}>
          {formattedTime}
        </Text>
      )}

      {role === "assistant" && phase && (
        <Text
          className={cn(
            isNative ? "text-xs px-2 py-0.5 rounded" : "text-[9px] px-1 py-0.5 rounded",
            colors.accent
          )}
        >
          {phase}
        </Text>
      )}
    </View>
  )
}

export default TurnHeader
