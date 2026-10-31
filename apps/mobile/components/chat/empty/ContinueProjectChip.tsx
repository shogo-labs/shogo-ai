// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The "Continue <project>" chip (SHO-266).
 *
 * Shown once, directly above the composer, when a project chat is opened from a
 * lifecycle notification (build-ready / credits-reset). It names the project
 * and the one next step the last assistant turn left open; tapping stages that
 * line in the composer — it never sends, so the person stays in charge.
 *
 * Fits a 390px phone: the suggestion wraps to at most two lines and the chip
 * never pushes the composer off screen.
 */
import { View, Text, Pressable } from "react-native"
import { ArrowRight, Sparkles } from "lucide-react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { continueChipLabel } from "@/lib/chat/continue-suggestion"

export interface ContinueProjectChipProps {
  /** The project the notification was about; omitted renders a bare "Continue". */
  projectName?: string | null
  /** The single suggested next step, from the last assistant turn. */
  suggestion: string
  /** Stage `suggestion` in the composer. Must not send it. */
  onPress: () => void
  /** Hide it without staging anything. */
  onDismiss?: () => void
  className?: string
}

export function ContinueProjectChip({
  projectName,
  suggestion,
  onPress,
  onDismiss,
  className,
}: ContinueProjectChipProps) {
  const label = continueChipLabel(projectName)

  return (
    <View className={cn("px-3 pb-1.5", className)}>
      <View
        className={cn(
          "flex-row items-center gap-2 rounded-xl px-3 py-2",
          "bg-primary/5 border border-primary/20",
        )}
      >
        <Pressable
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={`${label}: ${suggestion}`}
          className="flex-1 flex-row items-center gap-2 active:opacity-70"
        >
          <Sparkles size={14} className="text-primary" />
          <View className="flex-1">
            <Text className="text-[11px] font-semibold text-primary" numberOfLines={1}>
              {label}
            </Text>
            <Text
              testID="continue-project-suggestion"
              className="text-xs text-foreground"
              numberOfLines={2}
            >
              {suggestion}
            </Text>
          </View>
          <ArrowRight size={14} className="text-primary" />
        </Pressable>
        {onDismiss ? (
          <Pressable
            onPress={onDismiss}
            accessibilityRole="button"
            accessibilityLabel={`Dismiss ${label}`}
            hitSlop={8}
            className="px-1 active:opacity-70"
          >
            <Text className="text-xs text-muted-foreground">✕</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  )
}

export default ContinueProjectChip
