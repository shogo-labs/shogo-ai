// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Camera, FolderOpen, Image as ImageIcon } from 'lucide-react-native'
import { Platform, type TextInputProps } from 'react-native'
import type { NativeAttachAction } from './native-attachment-picker'
import { NATIVE_PHONE_ICON } from './native-phone-layout'
import { SURFACE_COLORS } from './surface-tokens'

/**
 * Multiline composer input behavior: Return inserts a newline on native.
 *
 * On web this also suppresses the browser's autofill hinting: without an
 * explicit `off`, Chrome/Safari heuristically treat a generic empty text
 * field as a login/payment field and show a suggestion row (key/card/pin
 * icons) above the on-screen keyboard, crowding the chat composer.
 */
export function composerKeyboardProps(
  platform: string = Platform.OS,
): Pick<TextInputProps, 'blurOnSubmit' | 'returnKeyType' | 'autoComplete'> {
  return {
    blurOnSubmit: false,
    returnKeyType: platform === 'web' ? undefined : 'default',
    autoComplete: platform === 'web' ? 'off' : undefined,
  }
}

export const COMPOSER_KEYBOARD_PROPS = composerKeyboardProps()

/** Native send control — 40pt tap target, larger than the web 20px chip. */
export const NATIVE_COMPOSER_SEND_CLASS = "h-10 w-10"
export const NATIVE_COMPOSER_SEND_ICON = 20
export const WEB_COMPOSER_SEND_CLASS = "h-5 w-5"
export const WEB_COMPOSER_SEND_ICON = 12
/** Native idle mic: retain a 44pt target and keep the quiet chip chrome. */
export const NATIVE_COMPOSER_MIC_IDLE_CLASS =
  "h-11 w-11 border border-border/45 bg-muted/30"

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
    fill: SURFACE_COLORS.light.container,
    border: SURFACE_COLORS.light.containerHighest,
    borderFocus: '#E27927',
    text: NATIVE_PHONE_ICON.light,
    placeholder: '#71717A',
    icon: NATIVE_PHONE_ICON.light,
    sendFill: '#E27927',
    sendIcon: '#FFFFFF',
  },
  dark: {
    fill: SURFACE_COLORS.dark.container,
    border: SURFACE_COLORS.dark.containerHighest,
    borderFocus: '#F09050',
    text: NATIVE_PHONE_ICON.dark,
    placeholder: '#A3A3A3',
    icon: NATIVE_PHONE_ICON.dark,
    sendFill: '#F09050',
    sendIcon: '#FFFFFF',
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
