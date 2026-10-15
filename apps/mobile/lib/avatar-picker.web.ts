// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Picking a photo for a profile picture (web).
 *
 * A hidden `<input type="file" />`, matching how the composer picks attachments.
 * `expo-image-picker` is deliberately kept out of the web bundle, so this file
 * must not import it.
 *
 * Dimensions are read by decoding the object URL, because the crop needs to know
 * how much of the photo to keep and `File` alone does not say.
 */

export type AvatarPhotoSource = 'library' | 'camera'

export type PickedAvatarPhoto = { uri: string; width: number; height: number }

export type PickAvatarResult =
  | { ok: true; photo: PickedAvatarPhoto }
  | { ok: false; reason: 'cancelled' | 'denied' | 'unreadable'; message?: string }

function chooseFile(source: AvatarPhotoSource): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    // On mobile web this opens the camera instead of the library.
    if (source === 'camera') input.setAttribute('capture', 'user')
    input.style.display = 'none'
    input.addEventListener('change', () => {
      const file = input.files?.[0] ?? null
      input.remove()
      resolve(file)
    })
    // A cancelled picker fires no `change`; resolving on blur is what stops the
    // promise hanging forever, which would leave the button spinning.
    input.addEventListener('cancel', () => {
      input.remove()
      resolve(null)
    })
    document.body.appendChild(input)
    input.click()
  })
}

function measureImage(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => reject(new Error('Could not read that photo.'))
    image.src = uri
  })
}

export async function pickAvatarPhoto(source: AvatarPhotoSource): Promise<PickAvatarResult> {
  const file = await chooseFile(source)
  if (!file) return { ok: false, reason: 'cancelled' }

  const uri = URL.createObjectURL(file)
  try {
    const size = await measureImage(uri)
    return { ok: true, photo: { uri, width: size.width, height: size.height } }
  } catch {
    URL.revokeObjectURL(uri)
    return { ok: false, reason: 'unreadable', message: 'Could not read that photo.' }
  }
}
