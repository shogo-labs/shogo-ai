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

  test('strips surrounding angle brackets and quotes', () => {
    expect(parseEmailDraft('<a@x.com> "b@y.io" \'c@z.dev\'')).toEqual({
      valid: ['a@x.com', 'b@y.io', 'c@z.dev'],
      invalid: [],
    })
  })

  test('strips trailing punctuation', () => {
    expect(parseEmailDraft('a@x.com. b@y.io; c@z.dev,')).toEqual({
      valid: ['a@x.com', 'b@y.io', 'c@z.dev'],
      invalid: [],
    })
  })

  test('drops display names from "Name <email>" entries', () => {
    expect(parseEmailDraft('Alice Smith <Alice@x.com>, "Bob" <bob@y.io>.')).toEqual({
      valid: ['alice@x.com', 'bob@y.io'],
      invalid: [],
    })
  })

  test('returns nothing for blank input', () => {
    expect(parseEmailDraft('  ,  ')).toEqual({ valid: [], invalid: [] })
  })
})
