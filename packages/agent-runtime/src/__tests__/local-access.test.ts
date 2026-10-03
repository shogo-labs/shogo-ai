// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Local-access policy: per-app data access, blocked folders and computer use.
 *
 *   bun test packages/agent-runtime/src/__tests__/local-access.test.ts
 */

import { describe, expect, mock, test } from 'bun:test'

mock.module('@shogo/shared-runtime', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}))

const {
  checkComputerUse,
  checkFileAccess,
  checkShellAccess,
  normalizeLocalAccessPrefs,
  toLocalAccessPolicy,
  DEFAULT_LOCAL_ACCESS_PREFS,
} = await import('../local-access')
const { PermissionEngine } = await import('../permission-engine')

const HOME = '/Users/tester'
const ctx = { homeDir: HOME, workspaceDir: '/work/project' }

describe('normalizeLocalAccessPrefs', () => {
  test('fills defaults for empty and garbage input', () => {
    expect(normalizeLocalAccessPrefs(undefined)).toEqual(DEFAULT_LOCAL_ACCESS_PREFS)
    expect(normalizeLocalAccessPrefs('nope')).toEqual(DEFAULT_LOCAL_ACCESS_PREFS)
  })

  test('keeps valid app access and drops invalid values', () => {
    const prefs = normalizeLocalAccessPrefs({ apps: { mail: 'off', notes: 'bogus', ghost: 'read' } })
    expect(prefs.apps.mail).toBe('off')
    expect(prefs.apps.notes).toBe('read')
    expect((prefs.apps as Record<string, string>).ghost).toBeUndefined()
  })

  test('dedupes and trims blocked folders', () => {
    const prefs = normalizeLocalAccessPrefs({ blockedFolders: [' ~/Secret ', '~/Secret', '', 5] })
    expect(prefs.blockedFolders).toEqual(['~/Secret'])
  })

  test('null clears a dictation shortcut, missing keeps the default', () => {
    expect(normalizeLocalAccessPrefs({ dictation: { pushToTalk: null } }).dictation.pushToTalk).toBeNull()
    expect(normalizeLocalAccessPrefs({ dictation: {} }).dictation.pushToTalk).toBe('Fn')
  })
})

describe('checkFileAccess', () => {
  const policy = { apps: { messages: 'read', mail: 'off', notes: 'readwrite' } as const, blockedFolders: ['~/Private'] }

  test('read-only app data can be read but not written or deleted', () => {
    const p = `${HOME}/Library/Messages/chat.db`
    expect(checkFileAccess(policy, 'read', p, ctx).allowed).toBe(true)
    expect(checkFileAccess(policy, 'write', p, ctx).allowed).toBe(false)
    expect(checkFileAccess(policy, 'delete', p, ctx).allowed).toBe(false)
  })

  test('disabled app data is blocked for every operation', () => {
    const p = `${HOME}/Library/Mail/V10/Mailboxes`
    for (const op of ['read', 'write', 'delete'] as const) {
      expect(checkFileAccess(policy, op, p, ctx).allowed).toBe(false)
    }
  })

  test('read-write apps and unrelated paths are unrestricted', () => {
    expect(checkFileAccess(policy, 'write', `${HOME}/Library/Group Containers/group.com.apple.notes/x`, ctx).allowed).toBe(true)
    expect(checkFileAccess(policy, 'write', '/work/project/src/a.ts', ctx).allowed).toBe(true)
  })

  test('blocked folders deny everything beneath them, including ~ paths', () => {
    expect(checkFileAccess(policy, 'read', '~/Private/notes.txt', ctx).allowed).toBe(false)
    expect(checkFileAccess(policy, 'read', `${HOME}/PrivateStuff/x`, ctx).allowed).toBe(true)
  })

  test('no policy means no restriction', () => {
    expect(checkFileAccess(undefined, 'write', `${HOME}/Library/Mail/x`, ctx).allowed).toBe(true)
  })
})

describe('checkShellAccess', () => {
  const policy = { apps: { messages: 'read', mail: 'off' } as const, blockedFolders: ['/Volumes/Vault'] }

  test('commands naming a disabled app dir are blocked', () => {
    expect(checkShellAccess(policy, `ls ${HOME}/Library/Mail`, ctx).allowed).toBe(false)
    expect(checkShellAccess(policy, 'ls ~/Library/Mail', ctx).allowed).toBe(false)
    expect(checkShellAccess(policy, 'cat $HOME/Library/Mail/x', ctx).allowed).toBe(false)
  })

  test('AppleScript and open -a for a disabled app are blocked', () => {
    expect(checkShellAccess(policy, `osascript -e 'tell application "Mail" to get inbox'`, ctx).allowed).toBe(false)
    expect(checkShellAccess(policy, 'open -a Mail', ctx).allowed).toBe(false)
    expect(checkShellAccess(policy, `osascript -e 'tell application "Safari" to activate'`, ctx).allowed).toBe(true)
  })

  test('read-only apps allow reads but not mutating commands', () => {
    expect(checkShellAccess(policy, 'sqlite3 ~/Library/Messages/chat.db "select 1"', ctx).allowed).toBe(false)
    expect(checkShellAccess(policy, 'ls ~/Library/Messages', ctx).allowed).toBe(true)
    expect(checkShellAccess(policy, 'rm ~/Library/Messages/chat.db', ctx).allowed).toBe(false)
  })

  test('blocked folders are denied', () => {
    expect(checkShellAccess(policy, 'ls /Volumes/Vault/docs', ctx).allowed).toBe(false)
  })
})

describe('checkComputerUse', () => {
  test('only blocks computer-use when explicitly turned off', () => {
    expect(checkComputerUse({ computerUse: false }, 'computer-use').allowed).toBe(false)
    expect(checkComputerUse({ computerUse: true }, 'computer-use').allowed).toBe(true)
    expect(checkComputerUse({}, 'computer-use').allowed).toBe(true)
    expect(checkComputerUse(undefined, 'computer-use').allowed).toBe(true)
    expect(checkComputerUse({ computerUse: false }, 'github').allowed).toBe(true)
  })
})

describe('PermissionEngine integration', () => {
  function engine(localAccess: ReturnType<typeof toLocalAccessPolicy> | undefined) {
    return new PermissionEngine({
      preference: { mode: 'full_autonomy', localAccess },
      workspaceDir: '/work/project',
    })
  }

  test('denies disabled app data in full autonomy mode', () => {
    const e = engine({ apps: { mail: 'off' } })
    const r = e.check('file_read', 'read_file', { path: `${process.env.HOME}/Library/Mail/x` })
    expect(r.action).toBe('deny')
    expect(r.reason).toContain('turned off')
  })

  test('allows normal workspace access', () => {
    const e = engine({ apps: { mail: 'off' } })
    expect(e.check('file_write', 'write_file', { path: 'src/a.ts' }).action).toBe('allow')
  })

  test('setLocalAccess updates enforcement live', () => {
    const e = engine(undefined)
    const p = `${process.env.HOME}/Library/Messages/chat.db`
    expect(e.check('file_write', 'write_file', { path: p }).action).toBe('allow')
    e.setLocalAccess({ apps: { messages: 'read' } })
    expect(e.check('file_write', 'write_file', { path: p }).action).toBe('deny')
  })

  test('checkMcpTool follows the computerUse setting', () => {
    const e = engine({ computerUse: false })
    expect(e.checkMcpTool('computer-use').allowed).toBe(false)
    e.setLocalAccess({ computerUse: true })
    expect(e.checkMcpTool('computer-use').allowed).toBe(true)
  })
})
