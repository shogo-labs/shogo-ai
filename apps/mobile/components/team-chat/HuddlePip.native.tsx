// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** Document picture-in-picture is a browser feature; phones keep the floating card. Same exports as `HuddlePip.tsx`. */

export const pipSupported = false

export async function openPictureInPicture(): Promise<void> {}

export function closePictureInPicture(): void {}

export function usePictureInPicture() {
  return { supported: false, window: null as null, open: openPictureInPicture, close: closePictureInPicture }
}

export function useAutoPictureInPicture(_active: boolean): void {}

export function HuddlePip() {
  return null
}
