// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  mergePathLists,
  parseLoginShellOutput,
  readLoginShellPath,
  resolveDesktopPath,
} from '../login-shell-path'

const FINDER_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
const BUN_DIR = '/Applications/Shogo.app/Contents/Resources/bun'

describe('resolveDesktopPath', () => {
  test('a Finder-launched app gets the login shell PATH (docker, brew, node)', async () => {
    const path = await resolveDesktopPath({
      bunDir: BUN_DIR,
      inheritedPath: FINDER_PATH,
      platform: 'darwin',
      readShellPath: async () => '/Users/me/.nvm/versions/node/v22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
      exists: () => false,
    })
    expect(path.split(':')).toEqual([
      BUN_DIR,
      '/Users/me/.nvm/versions/node/v22/bin',
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ])
  })

  test('falls back to the Homebrew / Docker Desktop dirs when the shell cannot be read', async () => {
    const path = await resolveDesktopPath({
      bunDir: BUN_DIR,
      inheritedPath: FINDER_PATH,
      platform: 'darwin',
      readShellPath: async () => null,
      exists: (dir) => dir === '/usr/local/bin' || dir === '/opt/homebrew/bin',
    })
    expect(path).toBe(`${BUN_DIR}:${FINDER_PATH}:/opt/homebrew/bin:/usr/local/bin`)
  })

  test('a failing shell lookup never breaks startup', async () => {
    const path = await resolveDesktopPath({
      bunDir: BUN_DIR,
      inheritedPath: FINDER_PATH,
      platform: 'linux',
      readShellPath: async () => { throw new Error('boom') },
      exists: () => false,
    })
    expect(path).toBe(`${BUN_DIR}:${FINDER_PATH}`)
  })

  test('Windows keeps the inherited PATH untouched behind bun', async () => {
    const path = await resolveDesktopPath({
      bunDir: 'C:\\Shogo\\bun',
      inheritedPath: 'C:\\Windows\\system32',
      platform: 'win32',
      readShellPath: async () => '/should/not/be/used',
    })
    expect(path).toBe('C:\\Shogo\\bun;C:\\Windows\\system32')
  })
})

describe('login shell PATH parsing', () => {
  test('ignores rc-file noise around the marked PATH', () => {
    const out = 'Welcome back!\n__SHOGO_LOGIN_PATH__/opt/homebrew/bin:/usr/bin__SHOGO_LOGIN_PATH__\nbye'
    expect(parseLoginShellOutput(out)).toBe('/opt/homebrew/bin:/usr/bin')
    expect(parseLoginShellOutput('no markers here')).toBeNull()
  })

  test('merge keeps priority order and drops duplicates and empties', () => {
    expect(mergePathLists('/a:/b', '', null, '/b:/c::/a')).toBe('/a:/b:/c')
  })
})

describe('readLoginShellPath', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  function fakeShell(body: string): string {
    dir = mkdtempSync(join(tmpdir(), 'shogo-login-shell-'))
    const shell = join(dir, 'fake-shell')
    writeFileSync(shell, `#!/bin/sh\n${body}\n`)
    chmodSync(shell, 0o755)
    return shell
  }

  test('reads PATH from the shell it is given', async () => {
    const shell = fakeShell('echo "motd"; PATH=/opt/tools/bin:/usr/bin; shift; eval "$1"')
    expect(await readLoginShellPath({ shell })).toBe('/opt/tools/bin:/usr/bin')
  })

  test('gives up on a hanging shell', async () => {
    const shell = fakeShell('sleep 5')
    expect(await readLoginShellPath({ shell, timeoutMs: 200 })).toBeNull()
  })
})
