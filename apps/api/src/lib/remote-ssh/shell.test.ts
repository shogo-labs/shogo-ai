// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  commandFailureDetail,
  commandSucceeded,
  execChecked,
  quoteRemoteShellArgument,
  remotePathExpression,
} from './shell'

describe('remote shell helpers', () => {
  test('quotes single quotes and rejects NUL', () => {
    expect(quoteRemoteShellArgument("it's")).toBe("'it'\\''s'")
    expect(() => quoteRemoteShellArgument('a\u0000b')).toThrow('NUL')
  })

  test('expands only a leading home reference', () => {
    expect(remotePathExpression('~')).toBe('"$HOME"')
    expect(remotePathExpression('~/a b')).toBe(`"$HOME/"'a b'`)
    expect(remotePathExpression('$HOME/x')).toBe(`"$HOME/"'x'`)
    expect(remotePathExpression('/srv/$HOME/~')).toBe(`'/srv/$HOME/~'`)
  })

  test('treats a missing exit code as failure', () => {
    expect(commandSucceeded({ stdout: '', stderr: '', exitCode: 0 })).toBe(true)
    expect(commandSucceeded({ stdout: '', stderr: '', exitCode: null })).toBe(false)
    expect(commandFailureDetail({ stdout: '', stderr: '', exitCode: null })).toBe(
      'ssh did not exit normally',
    )
  })

  test('execChecked includes stderr in the thrown error', async () => {
    const runner = {
      exec: async () => ({ stdout: '', stderr: 'permission denied\n', exitCode: 1 }),
    }
    await expect(execChecked(runner, 'true', 'probe')).rejects.toThrow(
      'probe failed: permission denied',
    )
  })
})
