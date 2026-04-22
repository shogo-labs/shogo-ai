// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  runKeyFor,
  resolveRunDir,
  nextScreenshotPath,
  sweepLooseScreenshots,
  trimOldRuns,
} from '../screenshot-manager'

let workspace: string

beforeEach(() => {
  workspace = join(
    tmpdir(),
    `shogo-screenshot-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  mkdirSync(workspace, { recursive: true })
})

afterEach(() => {
  try { rmSync(workspace, { recursive: true, force: true }) } catch {}
})

describe('runKeyFor', () => {
  test('returns the instanceId when provided', () => {
    expect(runKeyFor('agent-123')).toBe('agent-123')
  })

  test('falls back to a dated main- key when no instanceId', () => {
    const key = runKeyFor(undefined)
    expect(key).toMatch(/^main-\d{4}-\d{2}-\d{2}$/)
  })

  test('treats empty / whitespace-only instanceId as missing', () => {
    expect(runKeyFor('')).toMatch(/^main-/)
    expect(runKeyFor('   ')).toMatch(/^main-/)
  })
})

describe('resolveRunDir', () => {
  test('creates .shogo/screenshots/<instanceId>/ and a .gitignore sentinel', () => {
    const dir = resolveRunDir(workspace, 'agent-abc')
    expect(dir).toBe(join(workspace, '.shogo/screenshots/agent-abc'))
    expect(existsSync(dir)).toBe(true)
    expect(existsSync(join(workspace, '.shogo/screenshots/.gitignore'))).toBe(true)
  })

  test('uses the dated main-<date> key when no instanceId is passed', () => {
    const dir = resolveRunDir(workspace)
    expect(dir).toMatch(/\.shogo\/screenshots\/main-\d{4}-\d{2}-\d{2}$/)
    expect(existsSync(dir)).toBe(true)
  })

  test('is idempotent across repeated calls for the same run', () => {
    const a = resolveRunDir(workspace, 'agent-abc')
    const b = resolveRunDir(workspace, 'agent-abc')
    expect(a).toBe(b)
  })
})

describe('nextScreenshotPath', () => {
  test('zero-pads the step counter to two digits', () => {
    const runDir = '/tmp/run'
    expect(nextScreenshotPath(runDir, 1)).toBe('/tmp/run/step-01.png')
    expect(nextScreenshotPath(runDir, 9)).toBe('/tmp/run/step-09.png')
    expect(nextScreenshotPath(runDir, 37)).toBe('/tmp/run/step-37.png')
  })

  test('falls back to natural width beyond 99', () => {
    expect(nextScreenshotPath('/tmp/run', 123)).toBe('/tmp/run/step-123.png')
  })

  test('clamps non-positive / fractional step counts to 1', () => {
    expect(nextScreenshotPath('/tmp/run', 0)).toBe('/tmp/run/step-01.png')
    expect(nextScreenshotPath('/tmp/run', -3)).toBe('/tmp/run/step-01.png')
    expect(nextScreenshotPath('/tmp/run', 2.9)).toBe('/tmp/run/step-02.png')
  })
})

describe('sweepLooseScreenshots', () => {
  test('moves matching files out of the workspace root into legacy/', () => {
    writeFileSync(join(workspace, 'screenshot-123.png'), 'a')
    writeFileSync(join(workspace, 'screenshot-foo.png'), 'b')
    writeFileSync(join(workspace, 'logo.png'), 'should be left alone')

    const moved = sweepLooseScreenshots(workspace)
    expect(moved).toBe(2)

    expect(existsSync(join(workspace, 'screenshot-123.png'))).toBe(false)
    expect(existsSync(join(workspace, 'screenshot-foo.png'))).toBe(false)
    expect(existsSync(join(workspace, 'logo.png'))).toBe(true)

    const legacy = join(workspace, '.shogo/screenshots/legacy')
    const legacyEntries = readdirSync(legacy)
    expect(legacyEntries).toContain('screenshot-123.png')
    expect(legacyEntries).toContain('screenshot-foo.png')
  })

  test('is a no-op when there is nothing to sweep', () => {
    writeFileSync(join(workspace, 'README.md'), '# hi')
    expect(sweepLooseScreenshots(workspace)).toBe(0)
    expect(existsSync(join(workspace, '.shogo/screenshots/legacy'))).toBe(false)
  })

  test('uniquifies filenames when colliding with an existing legacy entry', () => {
    const legacy = join(workspace, '.shogo/screenshots/legacy')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'screenshot-dup.png'), 'existing')
    writeFileSync(join(workspace, 'screenshot-dup.png'), 'new')

    expect(sweepLooseScreenshots(workspace)).toBe(1)

    const legacyEntries = readdirSync(legacy)
    expect(legacyEntries.length).toBe(2)
    expect(legacyEntries).toContain('screenshot-dup.png')
    expect(legacyEntries.some(n => n.endsWith('-screenshot-dup.png'))).toBe(true)
  })
})

describe('trimOldRuns', () => {
  test('keeps the N most recent run folders and removes the rest, preserving legacy/', () => {
    const root = join(workspace, '.shogo/screenshots')
    mkdirSync(root, { recursive: true })

    const runs = ['run-old-1', 'run-old-2', 'run-keep'] as const
    for (let i = 0; i < runs.length; i++) {
      const p = join(root, runs[i]!)
      mkdirSync(p, { recursive: true })
      const t = new Date(2026, 0, 1 + i) // strictly increasing mtimes
      utimesSync(p, t, t)
    }
    mkdirSync(join(root, 'legacy'), { recursive: true })
    writeFileSync(join(root, '.gitignore'), '*\n!.gitignore\n')

    const removed = trimOldRuns(workspace, 1)
    expect(removed).toBe(2)

    const remaining = readdirSync(root).sort()
    expect(remaining).toContain('run-keep')
    expect(remaining).toContain('legacy')
    expect(remaining).toContain('.gitignore')
    expect(remaining).not.toContain('run-old-1')
    expect(remaining).not.toContain('run-old-2')
  })

  test('is a no-op when run count is at or below the cap', () => {
    const root = join(workspace, '.shogo/screenshots')
    mkdirSync(join(root, 'run-a'), { recursive: true })
    mkdirSync(join(root, 'run-b'), { recursive: true })
    expect(trimOldRuns(workspace, 5)).toBe(0)
    expect(readdirSync(root).sort()).toEqual(['run-a', 'run-b'])
  })

  test('returns 0 when the screenshots root does not exist', () => {
    expect(trimOldRuns(workspace, 20)).toBe(0)
  })
})
