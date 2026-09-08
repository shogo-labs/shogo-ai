// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = readFileSync(resolve(import.meta.dir, '../AgentsPanel.tsx'), 'utf8')

describe('AgentsPanel native phone tabs', () => {
  test('pins equal pixel chip widths so Activity and Registry are not ellipsized', () => {
    expect(source).toContain('nativeEqualChipWidths')
    expect(source).toContain('nativeSettingsPaneStyle')
    expect(source).toContain('chips.chip')
    expect(source).toContain('chips.lastChip')
    expect(source).not.toContain('min-w-0 flex-1')
  })
})
