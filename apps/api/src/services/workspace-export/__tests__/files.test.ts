// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The file half of a workspace archive, on both layouts.
 *
 * This is the risky part of the feature: desktop roots a merged runtime at
 * `.workspace-roots/<workspaceId>` (workspace-session) *or*
 * `.workspace-roots/proj-<anchorProjectId>` (project-anchored) and puts a
 * **symlink per project** inside it, while cloud has **real sibling dirs**.
 * Walking naively drops every project on desktop and duplicates every project
 * on cloud. One test per layout, as the card asks.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectWorkspaceRootFiles,
  isExcludedRelPath,
  resolveWorkspaceRoot,
} from '../files'

let root: string
let workspaces: string
let rootsDir: string

function write(path: string, contents: string) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, contents)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'shogo-ws-files-'))
  workspaces = join(root, 'workspaces')
  rootsDir = join(workspaces, '.workspace-roots')
  mkdirSync(rootsDir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('resolveWorkspaceRoot', () => {
  test('a workspace-session root is found by workspace id', () => {
    const dir = join(rootsDir, 'ws_1')
    mkdirSync(dir, { recursive: true })
    const resolved = resolveWorkspaceRoot('ws_1', [], workspaces)
    expect(resolved.dir).toBe(dir)
    expect(resolved.warnings).toEqual([])
  })

  test('a project-anchored root is found through its project links', () => {
    const projectDir = join(workspaces, 'p1')
    mkdirSync(projectDir, { recursive: true })
    const anchorRoot = join(rootsDir, 'proj-p1')
    mkdirSync(anchorRoot, { recursive: true })
    symlinkSync(projectDir, join(anchorRoot, 'p1'))

    const resolved = resolveWorkspaceRoot('ws_1', ['p1'], workspaces)
    expect(resolved.dir).toBe(anchorRoot)
    expect(resolved.candidates).toEqual([anchorRoot])
  })

  test('never assumes proj-<workspaceId>', () => {
    mkdirSync(join(rootsDir, 'proj-ws_1'), { recursive: true })
    mkdirSync(join(rootsDir, 'proj-p1'), { recursive: true })
    symlinkSync(join(workspaces, 'p1'), join(rootsDir, 'proj-p1', 'p1'))

    const resolved = resolveWorkspaceRoot('ws_1', ['p1'], workspaces)
    expect(resolved.dir).toBe(join(rootsDir, 'proj-p1'))
  })

  test('both roots present: newest wins and the collision is reported', () => {
    const byId = join(rootsDir, 'ws_1')
    mkdirSync(byId, { recursive: true })
    mkdirSync(join(workspaces, 'p1'), { recursive: true })
    const anchored = join(rootsDir, 'proj-p1')
    mkdirSync(anchored, { recursive: true })
    symlinkSync(join(workspaces, 'p1'), join(anchored, 'p1'))

    const resolved = resolveWorkspaceRoot('ws_1', ['p1'], workspaces)
    expect(resolved.candidates.length).toBe(2)
    expect(resolved.warnings[0]).toContain('Several workspace roots exist')
  })

  test('no root at all resolves to null rather than an empty guess', () => {
    expect(resolveWorkspaceRoot('ws_missing', ['nope'], workspaces)).toEqual({
      dir: null,
      candidates: [],
      warnings: [],
    })
  })
})

describe('collectWorkspaceRootFiles', () => {
  test('desktop: keeps workspace files, drops every project symlink exactly once', () => {
    const projectDir = join(workspaces, 'p1')
    write(join(projectDir, 'src/App.tsx'), 'project-only')
    const workspaceRoot = join(rootsDir, 'ws_1')
    write(join(workspaceRoot, 'AGENTS.md'), 'agents')
    write(join(workspaceRoot, 'memory/2026-10-18.md'), 'memory')
    write(join(workspaceRoot, '.shogo/skills/review/SKILL.md'), 'skill')
    symlinkSync(projectDir, join(workspaceRoot, 'p1'))
    symlinkSync(workspaceRoot, join(workspaceRoot, 'loop'), 'dir')

    const files = collectWorkspaceRootFiles(workspaceRoot, ['p1'], [], new Set(), workspaces)
    expect(Object.keys(files).sort()).toEqual([
      '.shogo/skills/review/SKILL.md',
      'AGENTS.md',
      'memory/2026-10-18.md',
    ])
    // A self-referential link must not recurse.
    expect(Object.keys(files).some((name) => name.startsWith('loop/'))).toBe(false)
  })

  test('cloud: real sibling project dirs are dropped, not duplicated', () => {
    const workspaceRoot = join(rootsDir, 'ws_1')
    write(join(workspaceRoot, 'AGENTS.md'), 'agents')
    write(join(workspaceRoot, 'p1/src/App.tsx'), 'project-only')
    write(join(workspaceRoot, '.shogo/agents/dev.md'), 'agent')

    const files = collectWorkspaceRootFiles(workspaceRoot, ['p1'], [], new Set(), workspaces)
    expect(Object.keys(files).sort()).toEqual(['.shogo/agents/dev.md', 'AGENTS.md'])
  })

  test('volatile and machine-local files never travel', () => {
    const workspaceRoot = join(rootsDir, 'ws_1')
    write(join(workspaceRoot, 'state.db'), 'db')
    write(join(workspaceRoot, 'state.db-wal'), 'wal')
    write(join(workspaceRoot, '.shogo/install-marker'), 'hash')
    write(join(workspaceRoot, '.shogo-cwd-123'), '/tmp')
    write(join(workspaceRoot, '._AGENTS.md'), 'appledouble')

    const files = collectWorkspaceRootFiles(workspaceRoot, [], [], new Set(), workspaces)
    expect(Object.keys(files)).toEqual(['state.db'])
  })

  test('isExcludedRelPath only excludes the install marker by full path', () => {
    expect(isExcludedRelPath('.shogo/install-marker')).toBe(true)
    expect(isExcludedRelPath('projects/x/.shogo/install-marker')).toBe(true)
    expect(isExcludedRelPath('install-marker.txt')).toBe(false)
    expect(isExcludedRelPath('db.sqlite-wal')).toBe(true)
  })
})
