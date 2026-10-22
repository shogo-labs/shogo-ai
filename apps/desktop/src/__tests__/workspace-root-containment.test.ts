// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-152 step 5: a project opened through the pre-migration
 * `data/workspaces/<id>` path must still be trusted after the workspaces dir
 * moved to `data/workspaces.noindex` behind a back-compat symlink.
 *
 * The container half of the check is `fs:resolveWorkspace`'s security boundary,
 * so the accepted / rejected pairs are pinned here (it used to live inside
 * `fs-ipc.ts`, which imports Electron and can't be loaded under `bun test`).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { realpathOrSelf, resolveManagedWorkspaceRoot } from '../workspace-root-containment'
import { ensureWorkspacesNoIndex } from '../spotlight-exclusion'

let root: string
let dataDir: string
let legacyDir: string
let noIndexDir: string
let projectId: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'shogo-sho152-roots-'))
  dataDir = path.join(root, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  legacyDir = path.join(dataDir, 'workspaces')
  noIndexDir = path.join(dataDir, 'workspaces.noindex')
  projectId = '5c1f0a2e-project'
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function migrate(): void {
  fs.mkdirSync(path.join(legacyDir, projectId), { recursive: true })
  fs.writeFileSync(path.join(legacyDir, projectId, 'package.json'), '{}')
  const decision = ensureWorkspacesNoIndex(dataDir, { platform: 'darwin', log: () => {} })
  expect(decision.workspacesDir).toBe(noIndexDir)
}

describe('resolveManagedWorkspaceRoot after the Spotlight migration', () => {
  test('the workspaces dir is the real .noindex path', () => {
    migrate()
    expect(realpathOrSelf(legacyDir)).toBe(realpathOrSelf(noIndexDir))
  })

  test('a project opened through the legacy symlinked path is accepted', () => {
    migrate()

    const resolved = resolveManagedWorkspaceRoot(path.join(legacyDir, projectId), noIndexDir)

    expect(resolved).toBe(realpathOrSelf(path.join(noIndexDir, projectId)))
  })

  test('the same project through the new path resolves to the identical string', () => {
    migrate()

    const fromLegacy = resolveManagedWorkspaceRoot(path.join(legacyDir, projectId), noIndexDir)
    const fromNoIndex = resolveManagedWorkspaceRoot(path.join(noIndexDir, projectId), noIndexDir)

    expect(fromLegacy).toBe(fromNoIndex)
  })

  test('a leftover project only reachable through the real dir is still accepted', () => {
    migrate()
    const other = '9f2b-late-project'
    fs.mkdirSync(path.join(noIndexDir, other), { recursive: true })

    expect(resolveManagedWorkspaceRoot(path.join(noIndexDir, other), noIndexDir)).toBe(
      realpathOrSelf(path.join(noIndexDir, other)),
    )
  })

  test('boundary still rejects traversal, the root itself and nested paths', () => {
    migrate()
    const outside = path.join(root, 'outside')
    fs.mkdirSync(outside, { recursive: true })
    fs.mkdirSync(path.join(noIndexDir, projectId, 'nested'), { recursive: true })
    fs.symlinkSync(outside, path.join(noIndexDir, 'escape'), 'dir')

    const attempts = [
      path.join(legacyDir, '..', 'outside'),
      path.join(legacyDir, projectId, 'nested'),
      legacyDir,
      noIndexDir,
      '',
      path.join(noIndexDir, 'escape'),
      path.join(noIndexDir, 'does-not-exist'),
    ]
    for (const attempt of attempts) {
      expect(resolveManagedWorkspaceRoot(attempt, noIndexDir)).toBeNull()
    }
  })
})
