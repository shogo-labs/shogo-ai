// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  INTERNAL_EMAIL_PATTERNS,
  INTERNAL_EMAIL_SUFFIXES,
  isInternalEmail,
} from '../internal-accounts'

describe('internal accounts', () => {
  test('covers both Odin domains, and any future one', () => {
    expect(isInternalEmail('russell@getodin.ai')).toBe(true)
    expect(isInternalEmail('russell@getodin.io')).toBe(true)
    expect(isInternalEmail('someone@getodin.dev')).toBe(true)
  })

  test('covers Shogo and the test domain', () => {
    expect(isInternalEmail('dev@shogo.ai')).toBe(true)
    expect(isInternalEmail('qa@test.shogo.ai')).toBe(true)
  })

  test('leaves real users alone, including lookalike domains', () => {
    expect(isInternalEmail('someone@gmail.com')).toBe(false)
    expect(isInternalEmail('someone@notshogo.ai')).toBe(false)
    expect(isInternalEmail('someone@notgetodin.com')).toBe(false)
    expect(isInternalEmail(null)).toBe(false)
  })

  test('the prisma suffixes carry no LIKE wildcards left in them', () => {
    for (const suffix of INTERNAL_EMAIL_SUFFIXES) expect(suffix).not.toContain('%')
    expect(INTERNAL_EMAIL_SUFFIXES).toEqual(['@test.shogo.ai', '@shogo.ai', '@getodin.'])
    // The SQL side keeps the wildcard: it is a real `LIKE` pattern.
    expect(INTERNAL_EMAIL_PATTERNS).toContain('%@getodin.%')
  })
})
