// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Camera, FolderOpen, Image as ImageIcon } from 'lucide-react-native'
import { Platform, type TextInputProps } from 'react-native'
import type { NativeAttachAction } from './native-attachment-picker'
import { NATIVE_PHONE_ICON } from './native-phone-layout'

/** Multiline composer input behavior: Return inserts a newline on native. */
export function composerKeyboardProps(
  platform: string = Platform.OS,
): Pick<TextInputProps, 'blurOnSubmit' | 'returnKeyType'> {
  return {
    blurOnSubmit: false,
    returnKeyType: platform === 'web' ? undefined : 'default',
  }
}

export const COMPOSER_KEYBOARD_PROPS = composerKeyboardProps()

/** Shared ChatGPT-style composer colors used by both composer variants. */
export const CHATGPT_COMPOSER = {
  light: {
    fill: '#ffffff',
    border: '#e5e5e5',
    borderFocus: '#cfcfcf',
    text: NATIVE_PHONE_ICON.light,
    placeholder: '#8e8e8e',
    icon: NATIVE_PHONE_ICON.light,
    sendFill: NATIVE_PHONE_ICON.light,
    sendIcon: '#ffffff',
  },
  dark: {
    fill: '#212121',
    border: 'rgba(255,255,255,0.08)',
    borderFocus: 'rgba(255,255,255,0.16)',
    text: NATIVE_PHONE_ICON.dark,
    placeholder: '#8e8e8e',
    icon: NATIVE_PHONE_ICON.dark,
    sendFill: '#ffffff',
    sendIcon: NATIVE_PHONE_ICON.light,
  },
} as const

export type ComposerAttachRow = {
  action: NativeAttachAction
  label: string
  hint: string
  Icon: typeof Camera
}

/** One source of truth for the native plus-menu attachment actions. */
export const PLUS_ATTACH_ROWS: ComposerAttachRow[] = [
  { action: 'documents', label: 'Browse files', hint: 'Any file type', Icon: FolderOpen },
  { action: 'camera', label: 'Take photo', hint: 'Use your camera', Icon: Camera },
  { action: 'library', label: 'Photo library', hint: 'Pick from your gallery', Icon: ImageIcon },
]
