// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Web: ChatInput / CompactChatInput use a hidden <input type="file" />.
 * This file keeps expo-document-picker / expo-image-picker out of the web bundle.
 */

export interface NativePickedAttachment {
  id: string
  dataUrl: string
  name: string
  type: string
  size: number
}

export type NativeAttachAction = "library" | "camera" | "documents"

export interface NativeAttachPickerOptions {
  currentCount: number
  maxFiles: number
  maxFileSizeBytes: number
  onFiles: (files: NativePickedAttachment[]) => void
  onError: (message: string) => void
}

export function executeNativeAttachAction(
  _action: NativeAttachAction,
  _opts: NativeAttachPickerOptions
): void {
  // Native-only; web uses file input.
}
