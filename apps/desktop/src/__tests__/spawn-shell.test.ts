// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { resolveSpawnShell } from '../ipc/spawn-shell'

const winEnv = { ComSpec: 'C:\\Windows\\system32\\cmd.exe' }

describe('resolveSpawnShell', () => {
  test('Windows: the picker name "cmd" becomes ComSpec', () => {
    expect(resolveSpawnShell('cmd', 'win32', winEnv)).toBe('C:\\Windows\\system32\\cmd.exe')
    expect(resolveSpawnShell('CMD', 'win32', winEnv)).toBe('C:\\Windows\\system32\\cmd.exe')
    expect(resolveSpawnShell('cmd', 'win32', {})).toBe('cmd.exe')
  })

  test('Windows: other bare names get .exe so ConPTY can find them on PATH', () => {
    expect(resolveSpawnShell('pwsh', 'win32', winEnv)).toBe('pwsh.exe')
    expect(resolveSpawnShell('bash', 'win32', winEnv)).toBe('bash.exe')
  })

  test('Windows: names with an extension or a path are kept', () => {
    expect(resolveSpawnShell('powershell.exe', 'win32', winEnv)).toBe('powershell.exe')
    expect(resolveSpawnShell('C:\\Program Files\\Git\\bin\\bash.exe', 'win32', winEnv)).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
    expect(resolveSpawnShell('C:/tools/nu', 'win32', winEnv)).toBe('C:/tools/nu')
  })

  test('defaults: ComSpec on Windows, $SHELL elsewhere', () => {
    expect(resolveSpawnShell(undefined, 'win32', winEnv)).toBe('C:\\Windows\\system32\\cmd.exe')
    expect(resolveSpawnShell('', 'win32', {})).toBe('pwsh.exe')
    expect(resolveSpawnShell(undefined, 'darwin', { SHELL: '/bin/bash' })).toBe('/bin/bash')
    expect(resolveSpawnShell(undefined, 'linux', {})).toBe('/bin/zsh')
  })

  test('macOS and Linux names pass through unchanged', () => {
    expect(resolveSpawnShell('zsh', 'darwin', {})).toBe('zsh')
    expect(resolveSpawnShell('/usr/bin/fish', 'linux', {})).toBe('/usr/bin/fish')
  })
})
