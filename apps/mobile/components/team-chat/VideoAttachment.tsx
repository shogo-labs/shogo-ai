// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A video attached to a message: an inline player on web, a tile that opens
 * the system player on iOS and Android.
 */
import React from 'react'
import { Linking, Platform, Pressable, Text, View } from 'react-native'
import { PlayCircle } from 'lucide-react-native'
import { fitChatImage } from '../chat/turns/image-sizing'

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

export function VideoAttachment({ url, name, width, height, containerWidth }: { url: string; name: string; width?: number | null; height?: number | null; containerWidth?: number | null }) {
  // A video without recorded dimensions is assumed 16:9 rather than the 4:3 an image falls back to.
  const web = fitChatImage({ naturalWidth: width, naturalHeight: height, containerWidth, maxHeight: 360, fallbackAspect: 16 / 9 })
  if (Platform.OS === 'web') {
    return (
      <View className="overflow-hidden rounded-lg border border-border bg-black" style={{ width: web.width }}>
        <WebVideo
          src={url}
          controls
          preload="metadata"
          title={name}
          aria-label={name}
          data-testid="message-video"
          style={{ width: '100%', height: web.height, display: 'block', objectFit: 'contain' }}
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
