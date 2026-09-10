// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { composerKeyboardProps } from '../composer-phone'

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
