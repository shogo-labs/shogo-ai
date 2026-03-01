/**
 * TurnHeader Component (React Native)
 *
 * Shows role, timestamp, and phase badge for a conversation turn.
 */

import { View, Text } from "react-native"
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

  const formattedTime = timestamp
    ? timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null

  return (
    <View className={cn("flex-row items-center gap-1.5 mb-0.5", className)}>
      {role === "user" ? (
        <View className="w-4 h-4 rounded-full bg-primary/10 items-center justify-center">
          <User className="w-2.5 h-2.5 text-primary" />
        </View>
      ) : (
        <View className="w-4 h-4 rounded-full bg-muted items-center justify-center">
          <Bot className="w-2.5 h-2.5 text-muted-foreground" />
        </View>
      )}

      <Text
        className={cn(
          "text-[10px] font-medium",
          role === "user" ? "text-primary" : "text-muted-foreground"
        )}
      >
        {role === "user" ? "You" : "Shogo"}
      </Text>

      {formattedTime && (
        <Text className="text-[9px] text-muted-foreground/60 font-mono">
          {formattedTime}
        </Text>
      )}

      {role === "assistant" && phase && (
        <Text
          className={cn(
            "text-[9px] px-1 py-0.5 rounded",
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
