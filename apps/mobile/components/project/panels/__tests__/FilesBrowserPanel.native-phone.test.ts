// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = readFileSync(
  resolve(import.meta.dir, '../FilesBrowserPanel.tsx'),
  'utf8',
)

describe('FilesBrowserPanel native phone canvas', () => {
  test('paints the phone files tab with the ChatGPT canvas instead of muted gray', () => {
    expect(source).toContain('isNativePhoneIntegrationsLayout')
    expect(source).toContain('nativePhoneCanvas(isDark)')
    expect(source).toContain("isNativePhone\n            ? 'flex-1 bg-background'\n            : cn('border-r border-border bg-muted/30'")
  })
})
