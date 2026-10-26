// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { canonicalizeEmail, emailDomain } from '../email-canonical'

describe('canonicalizeEmail', () => {
  test('Gmail: dots and +tags are ignored, domain is gmail.com', () => {
    expect(canonicalizeEmail('John.Doe+promo@Gmail.com')).toBe('johndoe@gmail.com')
  })

  test('googlemail.com folds into gmail.com', () => {
    expect(canonicalizeEmail('a.b@googlemail.com')).toBe('ab@gmail.com')
  })

  test('other domains keep their dots and only lose the +tag', () => {
    expect(canonicalizeEmail('Jane.Doe+x@Company.io')).toBe('jane.doe@company.io')
  })

  test('input without an @ is lowercased and trimmed', () => {
    expect(canonicalizeEmail('  NotAnEmail ')).toBe('notanemail')
  })
})

describe('emailDomain', () => {
  test('returns the lowercased domain, or empty when there is no @', () => {
    expect(emailDomain('a@B.Com')).toBe('b.com')
    expect(emailDomain('nodomain')).toBe('')
  })
})
