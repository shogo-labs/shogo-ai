// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import { extractCommandText } from '../terminal-command-text'
import type { Command } from '../osc633-tracker'

describe('extractCommandText', () => {
  it('prefers OSC633 commandLine when present', () => {
    const cmd = { commandLine: 'git status' } as Command
    expect(extractCommandText(cmd, null)).toBe('git status')
  })

  it('returns empty when no commandLine and no terminal', () => {
    const cmd = { commandLine: '' } as Command
    expect(extractCommandText(cmd, null)).toBe('')
  })
})
