// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  composerKeyboardProps,
  composerSendChrome,
  NATIVE_COMPOSER_MIC_IDLE_CLASS,
  NATIVE_COMPOSER_SEND_CLASS,
  NATIVE_COMPOSER_SEND_ICON,
  WEB_COMPOSER_SEND_CLASS,
  WEB_COMPOSER_SEND_ICON,
} from '../composer-phone'

describe('composerKeyboardProps', () => {
  test('uses the native Return key for multiline input', () => {
    expect(composerKeyboardProps('ios')).toEqual({
      blurOnSubmit: false,
      returnKeyType: 'default',
    })
    expect(composerKeyboardProps('android')).toEqual({
      blurOnSubmit: false,
      returnKeyType: 'default',
    })
  })

  test('leaves the web keyboard behavior to the browser', () => {
    expect(composerKeyboardProps('web')).toEqual({
      blurOnSubmit: false,
      returnKeyType: undefined,
    })
  })
})

describe('native composer send control', () => {
  test('is a 44pt tap target, larger than the web chip', () => {
    expect(composerSendChrome(true)).toEqual({
      sizeClassName: NATIVE_COMPOSER_SEND_CLASS,
      iconSize: NATIVE_COMPOSER_SEND_ICON,
    })
    expect(composerSendChrome(false)).toEqual({
      sizeClassName: WEB_COMPOSER_SEND_CLASS,
      iconSize: WEB_COMPOSER_SEND_ICON,
    })
    expect(NATIVE_COMPOSER_SEND_CLASS).toBe('h-11 w-11')
    expect(NATIVE_COMPOSER_MIC_IDLE_CLASS).toContain('h-11 w-11')
    expect(NATIVE_COMPOSER_MIC_IDLE_CLASS).toContain('border')
  })
})
