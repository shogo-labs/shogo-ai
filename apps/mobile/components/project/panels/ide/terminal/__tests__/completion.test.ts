// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import {
  advanceCdCompletion,
  applyCdCompletion,
  parseCdCompletion,
  type TerminalCompletionEntry,
} from '../completion'

const dirs = (...names: string[]): TerminalCompletionEntry[] =>
  names.map((name) => ({ name, type: 'directory' }))

describe('parseCdCompletion', () => {
  test('detects a cd path prefix at the end of the line', () => {
    expect(parseCdCompletion('cd f')).toMatchObject({
      pathPrefix: 'f',
      dirPrefix: '',
      leafPrefix: 'f',
    })
  })

  test('splits nested prefixes into directory and leaf parts', () => {
    expect(parseCdCompletion('cd src/comp')).toMatchObject({
      pathPrefix: 'src/comp',
      dirPrefix: 'src/',
      leafPrefix: 'comp',
    })
  })

  test('decodes escaped spaces for unquoted paths', () => {
    expect(parseCdCompletion('cd my\\ fol')).toMatchObject({
      pathPrefix: 'my fol',
      leafPrefix: 'my fol',
      quote: null,
    })
  })

  test('preserves quoted paths with spaces', () => {
    expect(parseCdCompletion('cd "my fol')).toMatchObject({
      pathPrefix: 'my fol',
      leafPrefix: 'my fol',
      quote: '"',
    })
  })

  test('does not activate for non-cd commands or cd special cases', () => {
    expect(parseCdCompletion('ls f')).toBeNull()
    expect(parseCdCompletion('cd')).toBeNull()
    expect(parseCdCompletion('cd ')).toBeNull()
    expect(parseCdCompletion('cd -')).toBeNull()
    expect(parseCdCompletion('cd --')).toBeNull()
  })

  test('does not activate in the middle of the input', () => {
    expect(parseCdCompletion('cd files', 3)).toBeNull()
  })
})

describe('applyCdCompletion', () => {
  test('completes a single directory and appends slash', () => {
    const ctx = parseCdCompletion('cd f')
    expect(ctx).not.toBeNull()

    const result = applyCdCompletion('cd f', ctx!, dirs('files'))

    expect(result?.value).toBe('cd files/')
    expect(result?.candidates.map((entry) => entry.name)).toEqual(['files'])
  })

  test('extends to a common prefix before cycling', () => {
    const ctx = parseCdCompletion('cd fo')
    expect(ctx).not.toBeNull()

    const result = applyCdCompletion('cd fo', ctx!, dirs('foo-app', 'foo-api'))

    expect(result?.value).toBe('cd foo-ap')
    expect(result?.state.index).toBe(-1)
  })

  test('cycles ambiguous candidates on repeated tab', () => {
    const ctx = parseCdCompletion('cd f')
    expect(ctx).not.toBeNull()

    const first = applyCdCompletion('cd f', ctx!, dirs('files', 'folders'))
    expect(first?.value).toBe('cd files/')

    const second = advanceCdCompletion(first!.value, first!.state)
    expect(second?.value).toBe('cd folders/')

    const third = advanceCdCompletion(second!.value, second!.state)
    expect(third?.value).toBe('cd files/')
  })

  test('keeps quote style when completing paths with spaces', () => {
    const ctx = parseCdCompletion('cd "my fol')
    expect(ctx).not.toBeNull()

    const result = applyCdCompletion('cd "my fol', ctx!, dirs('my folder'))

    expect(result?.value).toBe('cd "my folder/"')
  })

  test('escapes spaces when completing an unquoted path', () => {
    const ctx = parseCdCompletion('cd my\\ fol')
    expect(ctx).not.toBeNull()

    const result = applyCdCompletion('cd my\\ fol', ctx!, dirs('my folder'))

    expect(result?.value).toBe('cd my\\ folder/')
  })

  test('returns null when no candidates match the parsed prefix', () => {
    const ctx = parseCdCompletion('cd z')
    expect(ctx).not.toBeNull()

    expect(applyCdCompletion('cd z', ctx!, dirs('alpha'))).toBeNull()
  })
})
