// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** Emoji reactions for a huddle: the quick picker and the layer that floats them over the video. */
import { useEffect, useRef } from 'react'
import { Animated, Easing, Pressable, Text, View } from 'react-native'
import { REACTION_LIFETIME_MS, sendHuddleReaction, type HuddleReactionEvent } from '../../lib/huddle-call'

export const QUICK_REACTIONS = ['👍', '👏', '❤️', '😂', '🎉', '😮', '🙏', '🔥'] as const

/** A row of one-tap emoji. Stays open so you can send several in a row. */
export function ReactionPicker({ onPick }: { onPick?: (emoji: string) => void }) {
  return (
    <View className="flex-row flex-wrap items-center gap-1 rounded-full border border-border bg-card px-2 py-1 shadow-lg" testID="huddle-reaction-picker">
      {QUICK_REACTIONS.map((emoji) => (
        <Pressable
          key={emoji}
          accessibilityRole="button"
          accessibilityLabel={`React ${emoji}`}
          onPress={() => {
            void sendHuddleReaction(emoji)
            onPick?.(emoji)
          }}
          className="h-9 w-9 items-center justify-center rounded-full active:bg-muted hover:bg-muted"
        >
          <Text className="text-xl">{emoji}</Text>
        </Pressable>
      ))}
    </View>
  )
}

/** Stable horizontal position (percent) for a reaction so it doesn't jump between renders. */
export function reactionLane(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return 8 + (h % 76)
}

function FloatingReaction({ reaction, size }: { reaction: HuddleReactionEvent; size: number }) {
  const progress = useRef(new Animated.Value(0)).current
  useEffect(() => {
    Animated.timing(progress, { toValue: 1, duration: REACTION_LIFETIME_MS, easing: Easing.out(Easing.quad), useNativeDriver: true }).start()
  }, [progress])
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        bottom: 8,
        left: `${reactionLane(reaction.id)}%`,
        alignItems: 'center',
        opacity: progress.interpolate({ inputRange: [0, 0.1, 0.75, 1], outputRange: [0, 1, 1, 0] }),
        transform: [
          { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [0, -size * 3] }) },
          { scale: progress.interpolate({ inputRange: [0, 0.1, 1], outputRange: [0.6, 1.15, 1] }) },
        ],
      }}
      accessibilityLabel={`${reaction.name} reacted ${reaction.emoji}`}
      testID={`huddle-reaction-${reaction.id}`}
    >
      <Text style={{ fontSize: size }}>{reaction.emoji}</Text>
      <Text className="mt-0.5 rounded bg-black/60 px-1 text-[10px] text-white" numberOfLines={1}>
        {reaction.name}
      </Text>
    </Animated.View>
  )
}

/** Reactions rising over whatever is underneath. Never takes taps. */
export function ReactionOverlay({ reactions, size = 28 }: { reactions: HuddleReactionEvent[]; size?: number }) {
  if (!reactions.length) return null
  return (
    <View pointerEvents="none" className="absolute inset-0 overflow-hidden" testID="huddle-reaction-overlay">
      {reactions.map((r) => (
        <FloatingReaction key={r.id} reaction={r} size={size} />
      ))}
    </View>
  )
}
