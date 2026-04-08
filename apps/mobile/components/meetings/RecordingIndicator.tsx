// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useRef } from 'react'
import { View, Text, Pressable, Animated, Platform } from 'react-native'
import { useRouter } from 'expo-router'
import { Square } from 'lucide-react-native'
import { useRecording, formatDuration } from '../../lib/use-recording'

export function RecordingIndicator() {
  const { isRecording, duration, stopRecording, isDesktop, isLocal } = useRecording()
  const router = useRouter()
  const pulseAnim = useRef(new Animated.Value(1)).current

  useEffect(() => {
    if (!isRecording) return

    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 0.4,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 800,
          useNativeDriver: true,
        }),
      ])
    )
    pulse.start()
    return () => pulse.stop()
  }, [isRecording, pulseAnim])

  if ((!isDesktop && !isLocal) || !isRecording) return null

  return (
    <View
      className="absolute top-3 right-3 z-50"
      style={Platform.OS === 'web' ? { position: 'fixed' as any } : undefined}
    >
      <View className="flex-row items-center bg-red-600 rounded-full px-3 py-1.5 gap-2 shadow-lg">
        <Pressable
          onPress={() => router.push('/(app)/meetings' as any)}
          className="flex-row items-center gap-2"
        >
          <Animated.View
            style={{ opacity: pulseAnim }}
            className="w-2.5 h-2.5 rounded-full bg-white"
          />
          <Text className="text-white text-sm font-medium">
            {formatDuration(duration)}
          </Text>
        </Pressable>

        <Pressable
          onPress={stopRecording}
          className="ml-1 p-1 rounded-full bg-white/20 active:bg-white/30"
          accessibilityLabel="Stop recording"
        >
          <Square size={12} className="text-white" fill="white" />
        </Pressable>
      </View>
    </View>
  )
}
