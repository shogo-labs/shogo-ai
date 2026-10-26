// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Picking a photo for a profile picture (iOS/Android).
 *
 * Deliberately not the composer's attachment picker: that one base64-encodes
 * every selection because attachments travel as data URLs, which for a
 * camera-roll photo is a multi-megabyte round trip through JS before we resize
 * it anyway. Here the manipulator is handed the file URI directly.
 *
 * `allowsEditing` gives the platform's own square-crop UI where it exists, so
 * people can frame their own face rather than accept the centre crop.
 */

import * as ImagePicker from 'expo-image-picker'

export type AvatarPhotoSource = 'library' | 'camera'

export type PickedAvatarPhoto = { uri: string; width: number; height: number }

export type PickAvatarResult =
  | { ok: true; photo: PickedAvatarPhoto }
  | { ok: false; reason: 'cancelled' | 'denied' | 'unreadable'; message?: string }

export async function pickAvatarPhoto(source: AvatarPhotoSource): Promise<PickAvatarResult> {
  const permission = source === 'camera'
    ? await ImagePicker.requestCameraPermissionsAsync()
    : await ImagePicker.requestMediaLibraryPermissionsAsync()

  if (!permission.granted) {
    return {
      ok: false,
      reason: 'denied',
      message: source === 'camera'
        ? 'Allow camera access in Settings to take a photo.'
        : 'Allow photo access in Settings to choose a picture.',
    }
  }

  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ['images'],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 1,
  }

  const result = source === 'camera'
    ? await ImagePicker.launchCameraAsync(options)
    : await ImagePicker.launchImageLibraryAsync(options)

  if (result.canceled) return { ok: false, reason: 'cancelled' }

  const asset = result.assets?.[0]
  if (!asset?.uri) return { ok: false, reason: 'unreadable', message: 'Could not read that photo.' }

  return {
    ok: true,
    photo: { uri: asset.uri, width: asset.width ?? 0, height: asset.height ?? 0 },
  }
}
