// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect } from 'bun:test'
import { parseSlashCommand } from '../slash-commands'

describe('parseSlashCommand', () => {
  test('plain text is a prompt (preserves raw text)', () => {
    expect(parseSlashCommand('fix the bug')).toEqual({ type: 'prompt', text: 'fix the bug' })
  })

  test('/exit and aliases', () => {
    expect(parseSlashCommand('/exit')).toEqual({ type: 'exit' })
    expect(parseSlashCommand('/quit')).toEqual({ type: 'exit' })
    expect(parseSlashCommand('/q')).toEqual({ type: 'exit' })
  })

  test('/clear and /new', () => {
    expect(parseSlashCommand('/clear')).toEqual({ type: 'clear' })
    expect(parseSlashCommand('/new')).toEqual({ type: 'clear' })
  })

  test('/help and /?', () => {
    expect(parseSlashCommand('/help')).toEqual({ type: 'help' })
    expect(parseSlashCommand('/?')).toEqual({ type: 'help' })
  })

  test('/cwd and /pwd', () => {
    expect(parseSlashCommand('/cwd')).toEqual({ type: 'cwd' })
    expect(parseSlashCommand('/pwd')).toEqual({ type: 'cwd' })
  })

  test('/model with and without an argument', () => {
    expect(parseSlashCommand('/model')).toEqual({ type: 'model', model: undefined })
    expect(parseSlashCommand('/model claude-sonnet')).toEqual({ type: 'model', model: 'claude-sonnet' })
  })

  test('unknown slash command reports its name', () => {
    expect(parseSlashCommand('/bogus arg')).toEqual({ type: 'unknown', name: 'bogus' })
  })

  test('leading/trailing whitespace is tolerated; case-insensitive', () => {
    expect(parseSlashCommand('   /EXIT  ')).toEqual({ type: 'exit' })
  })

  test('a bare slash with text is not treated as a command keyword we know', () => {
    expect(parseSlashCommand('/')).toEqual({ type: 'unknown', name: '' })
  })
})
