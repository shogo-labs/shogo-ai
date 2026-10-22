// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The delete path is the one place Shogo removes a user's files, and a
 * folder-linked project's folder is the user's real repo. These tests pin the
 * two rules that keep that safe:
 *   1. nothing outside `<WORKSPACES_DIR>` is ever removed, and
 *   2. a symlink is unlinked, never followed.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  directorySize,
  isInside,
  projectTaskStateDir,
  removeAppOwnedTree,
  removeWorkspaceFiles,
  resolveWorkspacesDir,
  workspaceFileInventory,
} from '../workspace-files.service'

let root: string
let workspacesDir: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'shogo-ws-files-'))
  workspacesDir = join(root, 'workspaces')
  mkdirSync(workspacesDir, { recursive: true })
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('resolveWorkspacesDir', () => {
  test('prefers the explicit value, then WORKSPACES_DIR', () => {
    const previous = process.env.WORKSPACES_DIR
    process.env.WORKSPACES_DIR = '/tmp/from-env'
    expect(resolveWorkspacesDir()).toBe('/tmp/from-env')
    expect(resolveWorkspacesDir('/tmp/explicit')).toBe('/tmp/explicit')
    if (previous === undefined) delete process.env.WORKSPACES_DIR
    else process.env.WORKSPACES_DIR = previous
  })
})

describe('isInside', () => {
  test('accepts strict descendants only', () => {
    expect(isInside('/a/b', '/a/b/c')).toBe(true)
    expect(isInside('/a/b', '/a/b')).toBe(false)
    expect(isInside('/a/b', '/a/bc')).toBe(false)
    expect(isInside('/a/b', '/a/c')).toBe(false)
    expect(isInside('/a/b', '/a/b/../c')).toBe(false)
  })
})

describe('directorySize', () => {
  test('sums files and skips symlinked targets', () => {
    const target = join(root, 'outside-target.bin')
    writeFileSync(target, Buffer.alloc(4096))
    const tree = join(root, 'sized')
    mkdirSync(join(tree, 'nested'), { recursive: true })
    writeFileSync(join(tree, 'a.txt'), 'hello')
    writeFileSync(join(tree, 'nested', 'b.txt'), 'world!')
    symlinkSync(target, join(tree, 'linked') )

    // 5 + 6 bytes of real content; the 4 KiB target is not counted.
    expect(directorySize(tree)).toBe(11)
  })
})

describe('removeAppOwnedTree', () => {
  test('refuses a path outside the workspaces dir', () => {
    const outside = join(root, 'user-repo')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'index.ts'), 'export {}')
    expect(() => removeAppOwnedTree(outside, workspacesDir)).toThrow(/outside/)
    expect(existsSync(join(outside, 'index.ts'))).toBe(true)
  })

  test('removes the tree but leaves a symlinked target untouched', () => {
    const userRepo = join(root, 'folder-linked-repo')
    mkdirSync(userRepo, { recursive: true })
    writeFileSync(join(userRepo, 'keep.ts'), 'export const keep = true')

    const projectDir = join(workspacesDir, 'proj-with-link')
    mkdirSync(join(projectDir, 'src'), { recursive: true })
    writeFileSync(join(projectDir, 'src', 'app.ts'), 'export {}')
    symlinkSync(userRepo, join(projectDir, 'external-link'))

    removeAppOwnedTree(projectDir, workspacesDir)

    expect(existsSync(projectDir)).toBe(false)
    expect(readFileSync(join(userRepo, 'keep.ts'), 'utf8')).toContain('keep')
  })

  test('unlinks a root that is itself a symlink instead of walking into it', () => {
    const userRepo = join(root, 'root-link-repo')
    mkdirSync(userRepo, { recursive: true })
    writeFileSync(join(userRepo, 'keep.ts'), 'export {}')

    const linkedDir = join(workspacesDir, 'linked-project')
    symlinkSync(userRepo, linkedDir)

    removeAppOwnedTree(linkedDir, workspacesDir)

    expect(existsSync(linkedDir)).toBe(false)
    expect(existsSync(join(userRepo, 'keep.ts'))).toBe(true)
  })

  test('is a no-op when the tree is already gone', () => {
    expect(() => removeAppOwnedTree(join(workspacesDir, 'never-existed'), workspacesDir)).not.toThrow()
  })
})

describe('workspaceFileInventory / removeWorkspaceFiles', () => {
  test('lists app-owned project dirs, keeps folder-linked paths out of removal', async () => {
    const workspaceId = 'ws-inventory'
    const managedDir = join(workspacesDir, 'proj-managed')
    mkdirSync(join(managedDir, 'src'), { recursive: true })
    writeFileSync(join(managedDir, 'src', 'index.ts'), 'x'.repeat(100))
    const mergedRoot = join(workspacesDir, '.workspace-roots', workspaceId)
    mkdirSync(mergedRoot, { recursive: true })
    writeFileSync(join(mergedRoot, 'link-marker'), '')
    const userRepo = join(root, 'my-linked-repo')
    mkdirSync(userRepo, { recursive: true })
    writeFileSync(join(userRepo, 'package.json'), '{}')

    const db = {
      workspace: {
        findUnique: async () => ({ id: workspaceId, name: 'Studio' }),
        delete: async () => ({}),
      },
      project: {
        findMany: async () => [
          {
            id: 'proj-managed',
            name: 'Managed',
            workingMode: 'managed',
            projectFolders: [],
          },
          {
            id: 'proj-linked',
            name: 'Linked',
            workingMode: 'external',
            projectFolders: [{ path: userRepo, isPrimary: true }],
          },
        ],
      },
      conversation: { count: async () => 2 },
      board: { count: async () => 1 },
      chatSession: { count: async () => 3 },
    }

    const inventory = await workspaceFileInventory(workspaceId, { workspacesDir, prisma: db })

    expect(inventory).not.toBeNull()
    expect(inventory!.workspaceName).toBe('Studio')
    expect(inventory!.removedDirs).toContain(managedDir)
    expect(inventory!.removedDirs).toContain(mergedRoot)
    expect(inventory!.removedDirs).not.toContain(userRepo)
    expect(inventory!.totalBytes).toBeGreaterThanOrEqual(100)
    expect(inventory!.channelCount).toBe(2)
    expect(inventory!.boardCount).toBe(1)
    expect(inventory!.chatCount).toBe(3)

    const linked = inventory!.projects.find((p) => p.id === 'proj-linked')!
    expect(linked.folderLinked).toBe(true)
    expect(linked.path).toBeNull()
    expect(linked.folderPath).toBe(userRepo)

    const report = removeWorkspaceFiles(inventory!, { workspacesDir })
    expect(report.warnings).toEqual([])
    expect(existsSync(managedDir)).toBe(false)
    expect(existsSync(mergedRoot)).toBe(false)
    expect(existsSync(join(userRepo, 'package.json'))).toBe(true)
  })

  test('returns null for an unknown workspace', async () => {
    const db = { workspace: { findUnique: async () => null }, project: {}, conversation: {}, board: {}, chatSession: {} }
    const inventory = await workspaceFileInventory('missing', { workspacesDir, prisma: db })
    expect(inventory).toBeNull()
  })

  test('a directory that cannot be removed becomes a warning, never a throw', () => {
    // The workspace row is already gone by the time files are removed, so the
    // only safe failure mode is a report. A path outside WORKSPACES_DIR is the
    // deterministic stand-in for "rm failed" (chmod is unreliable under root).
    const inventory = {
      workspaceId: 'ws-fail',
      workspaceName: 'Fail',
      projects: [],
      removedDirs: [join(root, 'user-repo')],
      channelCount: 0,
      boardCount: 0,
      chatCount: 0,
      totalBytes: 0,
    }
    const report = removeWorkspaceFiles(inventory, { workspacesDir })
    expect(report.removedDirs).toEqual([])
    expect(report.warnings).toHaveLength(1)
    expect(report.warnings[0]).toContain('outside')
    expect(existsSync(join(root, 'user-repo', 'index.ts'))).toBe(true)
  })
})

describe('project task-log state (<workspacesDir>/.shogo-state/<projectId>)', () => {
  test('is derived from the same root the runtime shares as /host-workspaces', () => {
    expect(projectTaskStateDir('/srv/workspaces', 'proj-1')).toBe('/srv/workspaces/.shogo-state/proj-1')
  })

  test('a deleted workspace sweeps every project state dir, folder-linked ones included', async () => {
    // SHO-151: the runtime keeps task logs at `.shogo-state/<projectId>` on
    // host-backed storage (task-log-durability.ts), outside the project tree.
    // A workspace delete has to take them with it, and "app-owned" is what
    // matters — a folder-linked project's own folder stays, its logs do not.
    const workspaceId = 'ws-state'
    const managedId = 'proj-state-managed'
    const linkedId = 'proj-state-linked'
    const otherId = 'proj-state-other'

    const managedDir = join(workspacesDir, managedId)
    mkdirSync(join(managedDir, 'src'), { recursive: true })
    writeFileSync(join(managedDir, 'src', 'index.ts'), 'x'.repeat(10))

    for (const [id, bytes] of [
      [managedId, 'a'.repeat(40)],
      [linkedId, 'b'.repeat(25)],
      [otherId, 'c'.repeat(500)],
    ] as const) {
      mkdirSync(join(projectTaskStateDir(workspacesDir, id), 'tasks'), { recursive: true })
      writeFileSync(join(projectTaskStateDir(workspacesDir, id), 'tasks', 'build.log'), bytes)
    }

    const userRepo = join(root, 'state-linked-repo')
    mkdirSync(userRepo, { recursive: true })
    writeFileSync(join(userRepo, 'package.json'), '{}')

    const db = {
      workspace: { findUnique: async () => ({ id: workspaceId, name: 'Sweep' }) },
      project: {
        findMany: async () => [
          { id: managedId, name: 'Managed', workingMode: 'managed', projectFolders: [] },
          {
            id: linkedId,
            name: 'Linked',
            workingMode: 'external',
            projectFolders: [{ path: userRepo, isPrimary: true }],
          },
        ],
      },
      conversation: { count: async () => 0 },
      board: { count: async () => 0 },
      chatSession: { count: async () => 0 },
    }

    const inventory = await workspaceFileInventory(workspaceId, { workspacesDir, prisma: db })

    expect(inventory!.removedDirs).toContain(projectTaskStateDir(workspacesDir, managedId))
    expect(inventory!.removedDirs).toContain(projectTaskStateDir(workspacesDir, linkedId))
    // The delete dialog's total covers the logs too (10 + 40 + 25 bytes).
    expect(inventory!.totalBytes).toBeGreaterThanOrEqual(75)

    const report = removeWorkspaceFiles(inventory!, { workspacesDir })

    expect(report.warnings).toEqual([])
    expect(existsSync(projectTaskStateDir(workspacesDir, managedId))).toBe(false)
    expect(existsSync(projectTaskStateDir(workspacesDir, linkedId))).toBe(false)
    // Another workspace's project keeps its logs: only this workspace's
    // projects are swept, never the whole `.shogo-state` root.
    expect(existsSync(join(projectTaskStateDir(workspacesDir, otherId), 'tasks', 'build.log'))).toBe(true)
    // The parent stays behind so a concurrent assign has somewhere to write.
    expect(existsSync(join(workspacesDir, '.shogo-state'))).toBe(true)
    expect(existsSync(join(userRepo, 'package.json'))).toBe(true)
  })

  test('a project with no task logs adds no removal entry', async () => {
    const db = {
      workspace: { findUnique: async () => ({ id: 'ws-state-none', name: 'Empty' }) },
      project: {
        findMany: async () => [
          { id: 'proj-state-nologs', name: 'No logs', workingMode: 'managed', projectFolders: [] },
        ],
      },
      conversation: { count: async () => 0 },
      board: { count: async () => 0 },
      chatSession: { count: async () => 0 },
    }

    const inventory = await workspaceFileInventory('ws-state-none', { workspacesDir, prisma: db })

    expect(inventory!.removedDirs).toEqual([])
  })

  test('a symlinked state dir is unlinked, its target is not followed', () => {
    const userRepo = join(root, 'state-target-repo')
    mkdirSync(userRepo, { recursive: true })
    writeFileSync(join(userRepo, 'keep.ts'), 'export {}')

    const stateDir = projectTaskStateDir(workspacesDir, 'proj-state-linked-out')
    mkdirSync(join(workspacesDir, '.shogo-state'), { recursive: true })
    symlinkSync(userRepo, stateDir)

    removeAppOwnedTree(stateDir, workspacesDir)

    expect(existsSync(stateDir)).toBe(false)
    expect(existsSync(join(userRepo, 'keep.ts'))).toBe(true)
  })
})
