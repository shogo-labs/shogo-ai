// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Turning a picked photo into a profile picture.
 *
 * The resize happens here rather than on the server because there is no image
 * pipeline server-side, and because it has to: `User.image` rides along in every
 * conversation message payload (`author.image`), so a camera-roll original would
 * be several megabytes and several thousand pixels re-sent with every message.
 * 512x512 is what Slack asks for and lands around 50 KB.
 */

import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'
import { Platform } from 'react-native'
import { API_URL } from './api'
import { nativeCookieHeader } from './team-chat-api'
import { localFilePart, type UploadPart } from './upload-part'

/** Square edge, and the size Slack asks for. Matches the server's ceiling. */
export const AVATAR_SIZE = 512

/** Visually indistinguishable at this size, and keeps the upload well under 1 MB. */
export const AVATAR_JPEG_QUALITY = 0.85

export type AvatarCropRect = { originX: number; originY: number; width: number; height: number }

/**
 * The largest centred square inside a photo.
 *
 * Centred rather than top-left so a portrait subject's face survives the crop —
 * a corner crop reliably cuts it off. Returns null when the source has no usable
 * dimensions, so the caller resizes without cropping instead of producing a
 * nonsense rectangle.
 */
export function avatarCropRect(width: number, height: number): AvatarCropRect | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  const edge = Math.min(width, height)
  if (edge < 1) return null
  return {
    originX: Math.floor((width - edge) / 2),
    originY: Math.floor((height - edge) / 2),
    width: Math.floor(edge),
    height: Math.floor(edge),
  }
}

export type PreparedAvatar = { uri: string; width: number; height: number }

/**
 * Centre-crops to a square, resizes to 512x512 and re-encodes as JPEG.
 *
 * Re-encoding also drops EXIF (including GPS) for free. The server strips it
 * again from the bytes it stores, so a caller that skips this step still cannot
 * leak the location a photo was taken at.
 */
export async function prepareAvatarImage(
  uri: string,
  source: { width?: number | null; height?: number | null },
): Promise<PreparedAvatar> {
  const context = ImageManipulator.manipulate(uri)
  const rect = avatarCropRect(Number(source.width ?? 0), Number(source.height ?? 0))
  if (rect) context.crop(rect)
  context.resize({ width: AVATAR_SIZE, height: AVATAR_SIZE })

  const rendered = await context.renderAsync()
  const saved = await rendered.saveAsync({
    format: SaveFormat.JPEG,
    compress: AVATAR_JPEG_QUALITY,
  })
  return { uri: saved.uri, width: saved.width, height: saved.height }
}

/**
 * The prepared image as a multipart part.
 *
 * Web puts a real `File` on the form; native sends `localFilePart`, because the
 * native global fetch can only encode strings, Blobs and `bytes()` parts (see
 * upload-part.ts).
 */
export async function avatarUploadPart(uri: string): Promise<File | UploadPart> {
  if (Platform.OS === 'web') {
    const blob = await (await fetch(uri)).blob()
    return new File([blob], 'avatar.jpg', { type: 'image/jpeg' })
  }
  return localFilePart(uri, 'avatar.jpg', 'image/jpeg')
}

async function readError(res: Response): Promise<string> {
  const body = await res.json().catch(() => null)
  return body?.error?.message ?? `Upload failed (${res.status})`
}

/**
 * Uploads a prepared picture and returns the URL the server stored.
 *
 * The URL is built server-side, so this only carries the bytes.
 */
export async function uploadAvatar(uri: string): Promise<string> {
  const form = new FormData()
  form.append('file', (await avatarUploadPart(uri)) as any)

  const res = await fetch(`${API_URL}/api/me/avatar`, {
    method: 'POST',
    body: form,
    credentials: Platform.OS === 'web' ? 'include' : 'omit',
    headers: nativeCookieHeader(),
  })
  if (!res.ok) throw new Error(await readError(res))

  const body = await res.json().catch(() => null)
  const image = body?.data?.image
  if (typeof image !== 'string' || !image) throw new Error('The server did not return a picture URL')
  return image
}

/** Clears the picture, so the UI falls back to initials. */
export async function removeAvatar(): Promise<void> {
  const res = await fetch(`${API_URL}/api/me/avatar`, {
    method: 'DELETE',
    credentials: Platform.OS === 'web' ? 'include' : 'omit',
    headers: nativeCookieHeader(),
  })
  if (!res.ok) throw new Error(await readError(res))
}
