// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = readFileSync(resolve(import.meta.dir, '../ChatDock.tsx'), 'utf8')

describe('ChatDock composer gap', () => {
  test('keeps error and status banners off the composer pill', () => {
    expect(source).toContain('NATIVE_PHONE_DOCK_COMPOSER_GAP')
    expect(source).toContain('paddingBottom: DOCK_COMPOSER_GAP')
    expect(source).not.toContain('mb-1.5 w-full max-w-3xl')
  })
})
