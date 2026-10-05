// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A small, still Shogo buddy for lists: the look's head, accessories and body
 * colour in a rounded square. Web draws the canvas directly; native shows a
 * cached picture from the shared hidden renderer (see `BuddySnapshotHost`),
 * with a tinted placeholder until it arrives.
 */
import { Image, Platform, View } from 'react-native'
import type { BuddyLook } from '@shogo/shared-app/buddy-look'
import { ShogoBuddy } from '../island/buddy/ShogoBuddy'
import { BUDDY_ASPECT } from '../island/buddy/engine'
import { useEffect, useSyncExternalStore } from 'react'
import { getSnapshot, requestSnapshot, snapshotKey, snapshotVersion, subscribeSnapshots } from '../../lib/buddy-snapshots'

/** Used when a look follows the app accent (the workspace agent's classic Shogo). */
export const DEFAULT_BUDDY_AVATAR_COLOR = '#FB8C00'

/** The buddy is drawn this much wider than the avatar, then cropped to head and body. */
const ZOOM = 1.1
/** Fraction of the drawn height cropped off the top, leaving room for toppers. */
const TOP_CROP = 0.3

export function buddyAvatarColor(look: BuddyLook): string {
  return look.color ?? DEFAULT_BUDDY_AVATAR_COLOR
}

export interface BuddyAvatarProps {
  look: BuddyLook
  size?: number
  accessibilityLabel?: string
}

export function BuddyAvatar({ look, size = 32, accessibilityLabel }: BuddyAvatarProps) {
  const color = buddyAvatarColor(look)
  const drawn = Math.round(size * ZOOM)
  return (
    <View
      accessible
      accessibilityLabel={accessibilityLabel}
      style={{ width: size, height: size, borderRadius: 8, overflow: 'hidden', backgroundColor: `${color}26` }}
      testID="buddy-avatar"
    >
      <View style={{ position: 'absolute', left: Math.round((size - drawn) / 2), top: -Math.round(drawn * TOP_CROP) }}>
        {Platform.OS === 'web' ? (
          <ShogoBuddy size={drawn} state="idle" color={color} look={look} still reducedMotion followPointer={false} />
        ) : (
          <SnapshotImage look={look} color={color} width={drawn} />
        )}
      </View>
    </View>
  )
}

function SnapshotImage({ look, color, width }: { look: BuddyLook; color: string; width: number }) {
  useSyncExternalStore(subscribeSnapshots, snapshotVersion, snapshotVersion)
  const key = snapshotKey(look, color)
  const uri = getSnapshot(key)
  useEffect(() => {
    requestSnapshot(look, color)
  }, [look, color, key])
  if (!uri) return <View style={{ width, height: Math.round(width * BUDDY_ASPECT) }} />
  return (
    <Image
      source={{ uri }}
      style={{ width, height: Math.round(width * BUDDY_ASPECT) }}
      accessibilityIgnoresInvertColors
      resizeMode="contain"
    />
  )
}
