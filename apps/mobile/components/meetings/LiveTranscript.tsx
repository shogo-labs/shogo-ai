// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useRef } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { formatDuration } from '../../lib/format-duration'
import type { LiveTranscriptState } from '../../lib/use-recording'

/** What's been said so far, a few seconds behind the room. */
export function LiveTranscript({ state, maxHeight = 168 }: { state: LiveTranscriptState; maxHeight?: number }) {
  const scrollRef = useRef<ScrollView>(null)
  return (
    <View className="mt-3 border-t border-red-500/20 pt-3" accessibilityLabel="Live transcript">
      <View className="mb-2 flex-row items-center gap-2">
        <View className={state.unavailable ? 'h-1.5 w-1.5 rounded-full bg-muted-foreground' : 'h-1.5 w-1.5 rounded-full bg-red-500'} />
        <Text className="text-[11px] font-semibold uppercase tracking-[1.2px] text-red-600">Live transcript</Text>
      </View>
      {state.unavailable ? (
        <Text className="text-xs leading-5 text-muted-foreground">
          {state.unavailable} The full transcript is still made when you stop.
        </Text>
      ) : state.segments.length === 0 ? (
        <Text className="text-xs leading-5 text-muted-foreground">Listening… words show up here a few seconds after they're said.</Text>
      ) : (
        <ScrollView
          ref={scrollRef}
          style={{ maxHeight }}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
        >
          {state.segments.map((segment, index) => (
            <View key={`${segment.start}-${index}`} className="mb-1.5 flex-row gap-2">
              <Text className="w-10 pt-0.5 text-right font-mono text-[10px] text-muted-foreground">
                {formatDuration(segment.start)}
              </Text>
              <Text className="flex-1 text-sm leading-5 text-foreground">{segment.text}</Text>
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  )
}
