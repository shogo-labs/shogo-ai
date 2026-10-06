// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { summarizeTurnTools, turnSummaryText } from '../turn-summary'

const tool = (toolName: string, state = 'success', args?: Record<string, unknown>) => ({ toolName, state, args })

describe('summarizeTurnTools', () => {
  test('counts steps and failures', () => {
    expect(summarizeTurnTools([tool('exec'), tool('exec', 'error'), tool('read_file', 'success', { path: 'a' })])).toEqual({
      steps: 3,
      failed: 1,
      files: [],
    })
  })

  test('lists each changed file once, in order, and ignores reads', () => {
    const summary = summarizeTurnTools([
      tool('edit_file', 'success', { path: 'b.ts' }),
      tool('write_file', 'success', { file_path: 'a.ts' }),
      tool('edit_file', 'success', { path: 'b.ts' }),
      tool('read_file', 'success', { path: 'c.ts' }),
    ])
    expect(summary.files).toEqual(['b.ts', 'a.ts'])
  })
})

describe('turnSummaryText', () => {
  test('is null when nothing ran', () => {
    expect(turnSummaryText({ steps: 0, failed: 0, files: [] })).toBeNull()
  })

  test('reads naturally, singular and plural', () => {
    expect(turnSummaryText({ steps: 1, failed: 0, files: [] })).toBe('1 step')
    expect(turnSummaryText({ steps: 4, failed: 1, files: ['a', 'b'] })).toBe('4 steps · 2 files changed · 1 failed')
    expect(turnSummaryText({ steps: 2, failed: 0, files: ['a'] })).toBe('2 steps · 1 file changed')
  })
})
