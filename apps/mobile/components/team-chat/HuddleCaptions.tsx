// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The live captions strip: two or three speaker-labelled lines over a dark
 * backdrop, newest at the bottom, above the control bar. It is display only —
 * turning captions off hides the strip on this device and never stops the
 * transcription the call's notes are doing.
 */
import { Text, View, useWindowDimensions } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { captionWindow, type CaptionLine } from '../../lib/huddle-captions'

export interface HuddleCaptionsProps {
  lines: CaptionLine[]
  /** The name to show for a person id; `HuddleCaptions` never reads it from the stream. */
  nameOf: (speakerId: string) => string | undefined
  /** Notes are off: say why there is nothing to caption instead of hiding silently. */
  notesOff?: boolean
  /** The wake indicator, when the workspace agent is working or has answered. */
  notice?: string | null
  /** Room to leave for the tiles above (the strip is capped, never growing past it). */
  className?: string
}

export function HuddleCaptions({ lines, nameOf, notesOff, notice, className }: HuddleCaptionsProps) {
  const { width } = useWindowDimensions()
  const visible = lines.slice(-captionWindow(width))
  if (!visible.length && !notice && !notesOff) return null
  return (
    <View className={cn('mx-3 mb-2 gap-1', className)} testID="huddle-captions">
      {visible.map((line) => (
        <View key={line.itemId} className="flex-row items-start gap-1.5 rounded-lg bg-black/60 px-2.5 py-1.5">
          <Text className="text-[14px] font-semibold leading-5 text-emerald-300" numberOfLines={1}>
            {nameOf(line.speakerId) ?? 'Someone'}
          </Text>
          <Text
            // Only settled lines are announced, so a screen reader isn't fed every partial.
            accessibilityLiveRegion={line.final ? 'polite' : 'none'}
            className={cn('flex-1 text-[15px] leading-5', line.final ? 'text-white' : 'text-white/70')}
          >
            {line.text}
          </Text>
        </View>
      ))}
      {notice ? (
        <View className="flex-row items-center gap-1.5 rounded-lg bg-black/60 px-2.5 py-1.5">
          <Text className="text-[13px] text-amber-300">{notice}</Text>
        </View>
      ) : null}
      {notesOff && !visible.length && !notice ? (
        <View className="flex-row items-center gap-1.5 rounded-lg bg-black/60 px-2.5 py-1.5">
          <Text className="text-[13px] text-white/70">Captions need notes on</Text>
        </View>
      ) : null}
    </View>
  )
}
