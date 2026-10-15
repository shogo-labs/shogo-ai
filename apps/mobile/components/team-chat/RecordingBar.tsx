// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The bar that replaces the composer while a voice note records: a live level
 * meter, how long it has run, a way out, and a way to finish.
 */

import { useEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { Check, Trash2 } from 'lucide-react-native'
import { MAX_VOICE_NOTE_MS, formatClipDuration } from '../../lib/voice-note'

const METER_BARS = 22

export function RecordingBar({
  level,
  elapsedMs,
  onCancel,
  onFinish,
}: {
  /** Latest 0-100 level from the recorder. */
  level: number
  elapsedMs: number
  onCancel: () => void
  onFinish: () => void
}) {
  const [meter, setMeter] = useState<number[]>([])
  useEffect(() => {
    setMeter((previous) => [...previous.slice(-(METER_BARS - 1)), level])
  }, [level])
  // Padded on the left so the bars scroll in from the right.
  const bars = [...Array(Math.max(0, METER_BARS - meter.length)).fill(0), ...meter]
  const nearCap = elapsedMs >= MAX_VOICE_NOTE_MS - 10_000

  return (
    <View className="flex-row items-center gap-3 rounded-2xl border border-border bg-card px-3 py-2">
      <Pressable
        onPress={onCancel}
        accessibilityRole="button"
        accessibilityLabel="Cancel recording"
        className="h-9 w-9 items-center justify-center rounded-full bg-muted active:opacity-80"
      >
        <Trash2 size={15} className="text-muted-foreground" />
      </Pressable>

      <View className="flex-1 flex-row items-center" style={{ gap: 2, height: 28 }}>
        {bars.map((value, index) => (
          <View
            key={index}
            className="flex-1 rounded-full bg-primary/70"
            style={{ height: Math.max(3, Math.round((value / 100) * 26)) }}
          />
        ))}
      </View>

      <View className="items-end">
        <Text className="text-xs text-foreground" style={{ fontVariant: ['tabular-nums'] }}>
          {formatClipDuration(elapsedMs)}
        </Text>
        {nearCap ? (
          <Text className="text-[10px] text-muted-foreground">
            Max {formatClipDuration(MAX_VOICE_NOTE_MS)}
          </Text>
        ) : null}
      </View>

      <Pressable
        onPress={onFinish}
        accessibilityRole="button"
        accessibilityLabel="Finish recording"
        className="h-9 w-9 items-center justify-center rounded-full bg-primary active:opacity-80"
      >
        <Check size={16} className="text-primary-foreground" />
      </Pressable>
    </View>
  )
}
