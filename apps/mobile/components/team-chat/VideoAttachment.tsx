// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A video attached to a message: an inline player on web, a tile that opens
 * the system player on iOS and Android.
 */
import React from 'react'
import { Linking, Platform, Pressable, Text, View } from 'react-native'
import { PlayCircle } from 'lucide-react-native'

interface WebVideoProps {
  src: string
  controls?: boolean
  preload?: string
  title?: string
  'aria-label'?: string
  'data-testid'?: string
  style?: React.CSSProperties
}
// React Native Web passes unknown host component names straight to the DOM.
const WebVideo = 'video' as unknown as React.FC<WebVideoProps>

export function VideoAttachment({ url, name, width, height }: { url: string; name: string; width?: number | null; height?: number | null }) {
  const displayWidth = 320
  const displayHeight = width && height ? Math.min(360, (displayWidth * height) / width) : 180
  if (Platform.OS === 'web') {
    return (
      <View className="overflow-hidden rounded-lg border border-border bg-black" style={{ width: displayWidth }}>
        <WebVideo
          src={url}
          controls
          preload="metadata"
          title={name}
          aria-label={name}
          data-testid="message-video"
          style={{ width: '100%', height: displayHeight, display: 'block', objectFit: 'contain' }}
        />
      </View>
    )
  }
  return (
    <Pressable
      testID="message-video"
      accessibilityRole="button"
      accessibilityLabel={`Play ${name}`}
      onPress={() => void Linking.openURL(url).catch(() => {})}
      className="items-center justify-center gap-1 rounded-lg border border-border bg-black"
      style={{ width: 220, height: 124 }}
    >
      <PlayCircle size={32} color="#ffffff" />
      <Text className="max-w-[200px] text-xs text-white" numberOfLines={1}>{name}</Text>
    </Pressable>
  )
}
