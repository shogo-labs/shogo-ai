// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-152: every live state of the macOS Spotlight migration.
 *
 * The platform is pinned to `darwin` on every test so the rename/symlink logic
 * runs for real (against temp dirs) on any CI host.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ensureWorkspacesNoIndex,
  LEGACY_WORKSPACES_DIRNAME,
  NOINDEX_WORKSPACES_DIRNAME,
} from '../spotlight-exclusion'

let root: string
let dataDir: string
let legacyDir: string
let noIndexDir: string

function silent(): { log: (message: string) => void; messages: string[] } {
  const messages: string[] = []
  return { log: (message: string) => messages.push(message), messages }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'shogo-sho152-'))
  dataDir = path.join(root, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  legacyDir = path.join(dataDir, LEGACY_WORKSPACES_DIRNAME)
  noIndexDir = path.join(dataDir, NOINDEX_WORKSPACES_DIRNAME)
})

afterEach(() => {
  try {
    fs.chmodSync(dataDir, 0o755)
  } catch {
    // The rename-failure test may have left it read-only.
  }
  fs.rmSync(root, { recursive: true, force: true })
})

describe('ensureWorkspacesNoIndex', () => {
  test('non-darwin: keeps data/workspaces and touches nothing', () => {
    const { log } = silent()
    const decision = ensureWorkspacesNoIndex(dataDir, { platform: 'linux', log })

    expect(decision).toEqual({
      workspacesDir: legacyDir,
      excluded: false,
      migrated: false,
      blocked: null,
    })
    expect(fs.existsSync(legacyDir)).toBe(false)
    expect(fs.existsSync(noIndexDir)).toBe(false)
  })

  test('windows: keeps data/workspaces and touches nothing', () => {
    const decision = ensureWorkspacesNoIndex(dataDir, { platform: 'win32', log: () => {} })
    expect(decision.workspacesDir).toBe(legacyDir)
    expect(decision.excluded).toBe(false)
    expect(fs.existsSync(noIndexDir)).toBe(false)
  })

  test('fresh install: creates workspaces.noindex plus the back-compat symlink', () => {
    const decision = ensureWorkspacesNoIndex(dataDir, { platform: 'darwin', log: () => {} })

    expect(decision.workspacesDir).toBe(noIndexDir)
    expect(decision.excluded).toBe(true)
    expect(decision.migrated).toBe(false)
    expect(decision.blocked).toBeNull()
    expect(fs.lstatSync(noIndexDir).isDirectory()).toBe(true)
    expect(fs.lstatSync(legacyDir).isSymbolicLink()).toBe(true)
    // Relative link target, so the data dir can be moved as a whole.
    expect(fs.readlinkSync(legacyDir)).toBe(NOINDEX_WORKSPACES_DIRNAME)
  })

  test('legacy real dir: renamed in place, contents kept, symlink left behind', () => {
    const projectDir = path.join(legacyDir, 'project-1')
    fs.mkdirSync(path.join(projectDir, 'node_modules', 'left-pad'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'node_modules', 'left-pad', 'package.json'), '{}')

    const { log, messages } = silent()
    const decision = ensureWorkspacesNoIndex(dataDir, { platform: 'darwin', log })

    expect(decision).toEqual({
      workspacesDir: noIndexDir,
      excluded: true,
      migrated: true,
      blocked: null,
    })
    expect(fs.lstatSync(noIndexDir).isDirectory()).toBe(true)
    expect(fs.lstatSync(legacyDir).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(legacyDir)).toBe(NOINDEX_WORKSPACES_DIRNAME)
    // The rename moved the tree; nothing was copied or re-created.
    expect(fs.existsSync(path.join(noIndexDir, 'project-1', 'node_modules', 'left-pad', 'package.json'))).toBe(true)
    // Old absolute paths still reach the same files.
    expect(fs.existsSync(path.join(legacyDir, 'project-1', 'node_modules'))).toBe(true)
    expect(messages.some((m) => m.includes('moved the workspaces dir'))).toBe(true)
  })

  test('already migrated: a second call is a no-op', () => {
    fs.mkdirSync(path.join(legacyDir, 'project-1'), { recursive: true })

    const first = ensureWorkspacesNoIndex(dataDir, { platform: 'darwin', log: () => {} })
    expect(first.migrated).toBe(true)

    const { log, messages } = silent()
    const second = ensureWorkspacesNoIndex(dataDir, { platform: 'darwin', log })

    expect(second).toEqual({
      workspacesDir: noIndexDir,
      excluded: true,
      migrated: false,
      blocked: null,
    })
    expect(messages).toEqual([])
    expect(fs.existsSync(path.join(noIndexDir, 'project-1'))).toBe(true)
    expect(fs.readlinkSync(legacyDir)).toBe(NOINDEX_WORKSPACES_DIRNAME)
  })

  test('already migrated through an absolute symlink: recognised too', () => {
    fs.mkdirSync(noIndexDir, { recursive: true })
    fs.symlinkSync(noIndexDir, legacyDir, 'dir')

    const decision = ensureWorkspacesNoIndex(dataDir, { platform: 'darwin', log: () => {} })

    expect(decision.workspacesDir).toBe(noIndexDir)
    expect(decision.excluded).toBe(true)
    expect(decision.blocked).toBeNull()
  })

  test('dangling back-compat symlink: recreates the real dir', () => {
    fs.symlinkSync(NOINDEX_WORKSPACES_DIRNAME, legacyDir, 'dir')

    const decision = ensureWorkspacesNoIndex(dataDir, { platform: 'darwin', log: () => {} })

    expect(decision.workspacesDir).toBe(noIndexDir)
    expect(decision.excluded).toBe(true)
    expect(fs.lstatSync(noIndexDir).isDirectory()).toBe(true)
  })

  test('both as real dirs: uses .noindex, merges and deletes nothing', () => {
    fs.mkdirSync(path.join(legacyDir, 'old-project'), { recursive: true })
    fs.mkdirSync(path.join(noIndexDir, 'new-project'), { recursive: true })

    const { log, messages } = silent()
    const decision = ensureWorkspacesNoIndex(dataDir, { platform: 'darwin', log })

    expect(decision.workspacesDir).toBe(noIndexDir)
    expect(decision.excluded).toBe(true)
    expect(decision.migrated).toBe(false)
    expect(decision.blocked).toBe('both-exist')
    expect(decision.detail).toBe(legacyDir)
    // Neither side was touched.
    expect(fs.lstatSync(legacyDir).isDirectory()).toBe(true)
    expect(fs.existsSync(path.join(legacyDir, 'old-project'))).toBe(true)
    expect(fs.existsSync(path.join(noIndexDir, 'new-project'))).toBe(true)
    expect(messages.some((m) => m.includes('both'))).toBe(true)
  })

  test('foreign symlink: left alone, legacy path kept', () => {
    const elsewhere = path.join(root, 'relocated-workspaces')
    fs.mkdirSync(elsewhere, { recursive: true })
    fs.symlinkSync(elsewhere, legacyDir, 'dir')

    const decision = ensureWorkspacesNoIndex(dataDir, { platform: 'darwin', log: () => {} })

    expect(decision.workspacesDir).toBe(legacyDir)
    expect(decision.excluded).toBe(false)
    expect(decision.migrated).toBe(false)
    expect(decision.blocked).toBe('foreign-symlink')
    expect(fs.readlinkSync(legacyDir)).toBe(elsewhere)
    expect(fs.existsSync(noIndexDir)).toBe(false)
  })

  test('a file named workspaces: reported, never overwritten', () => {
    fs.writeFileSync(legacyDir, 'not a directory')

    const decision = ensureWorkspacesNoIndex(dataDir, { platform: 'darwin', log: () => {} })

    expect(decision.workspacesDir).toBe(legacyDir)
    expect(decision.excluded).toBe(false)
    expect(decision.blocked).toBe('rename-failed')
    expect(fs.readFileSync(legacyDir, 'utf-8')).toBe('not a directory')
    expect(fs.existsSync(noIndexDir)).toBe(false)
  })

  test('rename failure (read-only data dir): keeps the legacy path and says why', () => {
    if (process.platform === 'win32') return
    if (typeof process.getuid === 'function' && process.getuid() === 0) return
    fs.mkdirSync(path.join(legacyDir, 'project-1'), { recursive: true })
    fs.chmodSync(dataDir, 0o555)

    const { log, messages } = silent()
    const decision = ensureWorkspacesNoIndex(dataDir, { platform: 'darwin', log })

    expect(decision.workspacesDir).toBe(legacyDir)
    expect(decision.excluded).toBe(false)
    expect(decision.migrated).toBe(false)
    expect(decision.blocked).toBe('rename-failed')
    expect(decision.detail).toBeTruthy()
    expect(fs.existsSync(path.join(legacyDir, 'project-1'))).toBe(true)
    expect(fs.existsSync(noIndexDir)).toBe(false)
    expect(messages.some((m) => m.includes('could not rename'))).toBe(true)
  })
})

describe('workspaces dir stays a direct child of data/', () => {
  // `local-server.ts` derives BUN_INSTALL_CACHE_DIR as
  // `join(getWorkspacesDir(), '..', '.bun-cache')`, and
  // `ensureRuntimeTemplate()` copies into `join(getWorkspacesDir(), '_template')`.
  // Both keep working only while the handled directory is one level under
  // `data/` — an excluded path like `data/workspaces/.noindex` would silently
  // move the bun cache and the runtime template.
  test('darwin: parenting the decision gives back the data dir', () => {
    fs.mkdirSync(legacyDir, { recursive: true })
    const decision = ensureWorkspacesNoIndex(dataDir, { platform: 'darwin', log: () => {} })
    expect(path.join(decision.workspacesDir, '..', '.bun-cache')).toBe(path.join(dataDir, '.bun-cache'))
  })

  test('non-darwin: same invariant', () => {
    const decision = ensureWorkspacesNoIndex(dataDir, { platform: 'linux', log: () => {} })
    expect(path.join(decision.workspacesDir, '..', '.bun-cache')).toBe(path.join(dataDir, '.bun-cache'))
  })
})
