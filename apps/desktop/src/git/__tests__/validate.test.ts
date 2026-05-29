// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import { isSafeRefArg } from '../validate'

describe('isSafeRefArg', () => {
  it('accepts normal branch / remote names', () => {
    expect(isSafeRefArg('main')).toBe(true)
    expect(isSafeRefArg('feature/foo-bar')).toBe(true)
    expect(isSafeRefArg('origin')).toBe(true)
    expect(isSafeRefArg('release-2026.05')).toBe(true)
    expect(isSafeRefArg('a')).toBe(true)
  })

  it('rejects empty strings', () => {
    expect(isSafeRefArg('')).toBe(false)
  })

  it('rejects non-string input', () => {
    expect(isSafeRefArg(null)).toBe(false)
    expect(isSafeRefArg(undefined)).toBe(false)
    expect(isSafeRefArg(42)).toBe(false)
    expect(isSafeRefArg({})).toBe(false)
    expect(isSafeRefArg([])).toBe(false)
  })

  it('rejects flag-like arguments (the core threat)', () => {
    expect(isSafeRefArg('-')).toBe(false)
    expect(isSafeRefArg('-f')).toBe(false)
    expect(isSafeRefArg('--force')).toBe(false)
    expect(isSafeRefArg('--orphan')).toBe(false)
    expect(isSafeRefArg('--upload-pack=/tmp/x.sh')).toBe(false)
  })

  it('rejects whitespace anywhere in the value', () => {
    expect(isSafeRefArg('main branch')).toBe(false)
    expect(isSafeRefArg(' main')).toBe(false)
    expect(isSafeRefArg('main ')).toBe(false)
    expect(isSafeRefArg('main\tbranch')).toBe(false)
    expect(isSafeRefArg('main\nbranch')).toBe(false)
  })

  it('rejects control characters', () => {
    expect(isSafeRefArg('main\x00inject')).toBe(false)
    expect(isSafeRefArg('main\x1f')).toBe(false)
    expect(isSafeRefArg('main\x7f')).toBe(false)
  })

  it('rejects absurdly long names', () => {
    expect(isSafeRefArg('a'.repeat(250))).toBe(true)
    expect(isSafeRefArg('a'.repeat(251))).toBe(false)
    expect(isSafeRefArg('a'.repeat(10_000))).toBe(false)
  })

  it('accepts standard ref characters that git uses', () => {
    expect(isSafeRefArg('refs/heads/main')).toBe(true)
    expect(isSafeRefArg('origin/main')).toBe(true)
    expect(isSafeRefArg('v2.0.1')).toBe(true)
    expect(isSafeRefArg('user.name')).toBe(true)
  })
})
