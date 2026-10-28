// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { buildLocalCsp } from '../local-csp'

const API = 'http://localhost:39100'

function directive(csp: string, name: string): string[] | null {
  for (const part of csp.split(';')) {
    const [head, ...values] = part.trim().split(/\s+/)
    if (head === name) return values
  }
  return null
}

describe('buildLocalCsp', () => {
  const csp = buildLocalCsp(API)

  test('lets the file viewer play blob: media (SHO-229)', () => {
    expect(directive(csp, 'media-src')).toContain('blob:')
  })

  test('lets the PDF preview frame a blob: (SHO-224)', () => {
    expect(directive(csp, 'frame-src')).toContain('blob:')
    expect(directive(csp, 'child-src')).toContain('blob:')
  })

  test('lets the PDF viewer load its own chrome://resources UI', () => {
    // The blob frame inherits this policy, and Chromium's viewer builds its UI
    // from `chrome://resources`; without the scheme the frame is blank.
    expect(directive(csp, 'script-src')).toContain('chrome:')
  })

  test('keeps the API origin framable', () => {
    expect(directive(csp, 'frame-src')).toContain(API)
    expect(directive(csp, 'child-src')).toContain(API)
  })

  test('keeps blob: images working', () => {
    expect(directive(csp, 'img-src')).toContain('blob:')
  })

  test('leaves default-src alone and only adds chrome: to script-src', () => {
    expect(directive(csp, 'default-src')).toEqual(["'self'", 'shogo:', 'https:', 'http:'])
    expect(directive(csp, 'script-src')).toEqual([
      "'self'",
      'shogo:',
      'blob:',
      'chrome:',
      "'unsafe-inline'",
      "'unsafe-eval'",
    ])
  })
})
