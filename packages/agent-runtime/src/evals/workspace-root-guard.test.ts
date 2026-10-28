// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the workspace-root guard (SHO-195).
 *
 * `checkWorkspaceRootClean` decides the `workspace-root-clean` criterion, so it
 * has to fail on a root the agent built in and pass on a root the platform
 * merely cleaned. Real directories, real hashes, no LLM, no runtime.
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkWorkspaceRootClean, snapshotWorkspaceRoot } from './runtime-checks'

/** A root holding the seeded runtime template, plus its baseline. */
function seededRoot(files: Record<string, string> = { 'package.json': '{"name":"portfolio"}\n', 'src/App.tsx': 'export default 1\n' }) {
  const dir = mkdtempSync(join(tmpdir(), 'ws-root-clean-'))
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  const baseline = snapshotWorkspaceRoot(dir)
  return { dir, baseline, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('checkWorkspaceRootClean', () => {
  test('the seeded template, untouched, is clean', () => {
    const root = seededRoot()
    try {
      const check = checkWorkspaceRootClean(root.dir, { baseline: root.baseline })
      expect(check.ok).toBe(true)
      expect(check.forbidden).toEqual([])
      expect(check.modified).toEqual([])
    } finally {
      root.cleanup()
    }
  })

  test('an edited seeded file is dirty', () => {
    const root = seededRoot()
    try {
      writeFileSync(join(root.dir, 'src/App.tsx'), 'export default function App() { return null }\n')
      const check = checkWorkspaceRootClean(root.dir, { baseline: root.baseline })
      expect(check.ok).toBe(false)
      expect(check.modified).toContain('src/App.tsx')
    } finally {
      root.cleanup()
    }
  })

  test('a root app the eval did not seed is dirty', () => {
    const root = seededRoot({})
    try {
      mkdirSync(join(root.dir, 'src'), { recursive: true })
      writeFileSync(join(root.dir, 'src/App.tsx'), 'export default 1\n')
      writeFileSync(join(root.dir, 'index.html'), '<html></html>\n')
      const check = checkWorkspaceRootClean(root.dir, { baseline: root.baseline })
      expect(check.ok).toBe(false)
      expect(check.forbidden).toEqual(expect.arrayContaining(['src', 'index.html']))
    } finally {
      root.cleanup()
    }
  })

  test('a seeded template the platform removed is clean, and reported as missing', () => {
    // The pre-fix runtime clears the pool pre-seed at boot, after the eval took
    // its baseline. The root is then emptier than we seeded it — the run left
    // no app behind, so it must not fail the check (QA round 1).
    const root = seededRoot()
    try {
      rmSync(join(root.dir, 'src'), { recursive: true, force: true })
      rmSync(join(root.dir, 'package.json'), { force: true })
      const check = checkWorkspaceRootClean(root.dir, { baseline: root.baseline })
      expect(check.ok).toBe(true)
      expect(check.missing).toEqual(expect.arrayContaining(['package.json', 'src/App.tsx']))
    } finally {
      root.cleanup()
    }
  })

  test('an ordinary workspace with no seeded app is clean', () => {
    const root = seededRoot({})
    try {
      mkdirSync(join(root.dir, 'notes'), { recursive: true })
      writeFileSync(join(root.dir, 'notes/today.md'), '- a note\n')
      writeFileSync(join(root.dir, 'WORKSPACE.md'), '# Workspace\n')
      const check = checkWorkspaceRootClean(root.dir, { baseline: root.baseline })
      expect(check.ok).toBe(true)
      expect(check.forbidden).toEqual([])
    } finally {
      root.cleanup()
    }
  })
})
