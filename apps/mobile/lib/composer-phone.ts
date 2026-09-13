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

/** Native send control — 44pt tap target, larger than the web 20px chip. */
export const NATIVE_COMPOSER_SEND_CLASS = "h-11 w-11"
export const NATIVE_COMPOSER_SEND_ICON = 22
export const WEB_COMPOSER_SEND_CLASS = "h-5 w-5"
export const WEB_COMPOSER_SEND_ICON = 12
/** Native idle mic: same 44pt target, keep the quiet chip chrome. */
export const NATIVE_COMPOSER_MIC_IDLE_CLASS =
  `${NATIVE_COMPOSER_SEND_CLASS} border border-border/45 bg-muted/30`

export function composerSendChrome(phone: boolean): {
  sizeClassName: string
  iconSize: number
} {
  return phone
    ? { sizeClassName: NATIVE_COMPOSER_SEND_CLASS, iconSize: NATIVE_COMPOSER_SEND_ICON }
    : { sizeClassName: WEB_COMPOSER_SEND_CLASS, iconSize: WEB_COMPOSER_SEND_ICON }
}

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
