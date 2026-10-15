// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A person's photo at the size a chat row or header has room for. `Avatar`'s
 * smallest size is 32px, and those leading slots are 12–20px, so this draws
 * the circle itself. The photo is optional — someone who has not set one gets
 * their initial instead of an empty ring.
 */
import { useState } from 'react'
import { Image, Text, View } from 'react-native'
import { absoluteApiUrl } from '../../lib/team-chat-api'

export interface UserAvatarProps {
  name: string | null | undefined
  image?: string | null
  size: number
}

export function UserAvatar({ name, image, size }: UserAvatarProps) {
  const [failed, setFailed] = useState(false)
  const label = name?.trim() || '?'
  if (image && !failed) {
    return (
      <Image
        source={{ uri: absoluteApiUrl(image) }}
        style={{ width: size, height: size, borderRadius: size / 2 }}
        accessibilityLabel={`${label} avatar`}
        accessibilityIgnoresInvertColors
        onError={() => setFailed(true)}
      />
    )
  }
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2 }} className="items-center justify-center bg-muted">
      <Text style={{ fontSize: Math.round(size * 0.5) }} className="font-medium text-muted-foreground">
        {label.slice(0, 1).toUpperCase()}
      </Text>
    </View>
  )
}
