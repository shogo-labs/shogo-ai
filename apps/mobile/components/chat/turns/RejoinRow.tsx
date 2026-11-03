// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The row a reopened chat shows while it rejoins a turn that is still running
 * (SHO-297).
 *
 * It stands where the reply goes, under that turn's prompt, using the same
 * three-dot working treatment as a live turn — so the chat reads as "still
 * working" instead of frozen on the half-written reply from when the person
 * left. It is replaced by the resume snapshot the moment the window attaches.
 */
import { View, Text } from "react-native"
import { Motion } from "@legendapp/motion"

const DOT_DURATION = 600

export function RejoinRow() {
  return (
    <View
      testID="chat-rejoining-row"
      accessibilityLabel="Rejoining live reply"
      aria-busy={true}
      className="flex-row items-center gap-2 p-2"
    >
      <View className="flex-row items-center gap-1.5">
        {[0, 1, 2].map((i) => (
          <Motion.View
            key={i}
            initial={{ y: 0 }}
            animate={{ y: -4 }}
            transition={{
              type: "timing",
              duration: DOT_DURATION,
              easing: "easeInOut",
              delay: i * 150,
              repeat: Infinity,
              repeatReverse: true,
            }}
            className="w-2 h-2 rounded-full bg-muted-foreground/60"
          />
        ))}
      </View>
      <Text className="text-xs text-muted-foreground">Rejoining live reply…</Text>
    </View>
  )
}

export default RejoinRow
