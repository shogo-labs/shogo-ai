// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { parseEmailDraft } from '../email-draft'

describe('parseEmailDraft', () => {
  test('splits on commas, semicolons and whitespace and lowercases', () => {
    expect(parseEmailDraft('A@x.com, b@y.io;c@z.dev  d@w.co')).toEqual({
      valid: ['a@x.com', 'b@y.io', 'c@z.dev', 'd@w.co'],
      invalid: [],
    })
  })

  test('separates invalid tokens', () => {
    expect(parseEmailDraft('ok@x.com nope, also@bad')).toEqual({
      valid: ['ok@x.com'],
      invalid: ['nope', 'also@bad'],
    })
  })

  test('returns nothing for blank input', () => {
    expect(parseEmailDraft('  ,  ')).toEqual({ valid: [], invalid: [] })
  })
})
