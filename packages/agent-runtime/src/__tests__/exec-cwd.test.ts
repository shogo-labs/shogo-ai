// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The exec cwd marker: a temp file whose lifetime is the shell's, written
 * under `.shogo/exec-cwd/` so it never lands in the user's tree, and swept for
 * anything a crash left behind.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  EXEC_CWD_DIR,
  EXEC_CWD_MAX_AGE_MS,
  EXEC_CWD_PREFIX,
  consumeExecCwdMarker,
  execCwdDirFor,
  newExecCwdMarker,
  sweepExecCwdMarkers,
} from '../exec-cwd'

const DIR = '/tmp/test-exec-cwd'

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(DIR, { recursive: true })
})

afterEach(() => {
  rmSync(DIR, { recursive: true, force: true })
})

/** Backdate a file's mtime by `ms`. */
function age(file: string, ms: number): void {
  const secs = (Date.now() - ms) / 1000
  utimesSync(file, secs, secs)
}

describe('exec cwd markers', () => {
  test('marker names carry the prefix and are unique', () => {
    const a = newExecCwdMarker()
    const b = newExecCwdMarker()
    expect(a.startsWith(EXEC_CWD_PREFIX)).toBe(true)
    expect(a).not.toBe(b)
  })

  test('the marker directory is created under .shogo/exec-cwd', () => {
    const dir = execCwdDirFor(DIR)
    expect(dir).toBe(join(DIR, EXEC_CWD_DIR))
    expect(readdirSync(join(DIR, '.shogo'))).toContain('exec-cwd')
  })

  test('an uncreatable directory falls back instead of throwing', () => {
    // `.shogo` as a regular file is the simplest way to make mkdir fail.
    writeFileSync(join(DIR, '.shogo'), 'not a directory')
    expect(execCwdDirFor(DIR)).toBeNull()
  })

  test('consuming a marker returns the cwd the trap wrote and removes the file', () => {
    const dir = execCwdDirFor(DIR)!
    const file = join(dir, newExecCwdMarker())
    writeFileSync(file, `${DIR}/sub\n`)
    expect(consumeExecCwdMarker(file)).toBe(`${DIR}/sub`)
    expect(readdirSync(dir)).toEqual([])
    // Idempotent: a drained result and the exit-time capture can both run.
    expect(consumeExecCwdMarker(file)).toBeNull()
  })

  test('sweep removes stale markers and keeps fresh ones, at the root and in the directory', () => {
    const dir = execCwdDirFor(DIR)!
    const staleRoot = join(DIR, newExecCwdMarker())
    const freshRoot = join(DIR, newExecCwdMarker())
    const staleNested = join(dir, newExecCwdMarker())
    const freshNested = join(dir, newExecCwdMarker())
    for (const file of [staleRoot, freshRoot, staleNested, freshNested]) writeFileSync(file, `${DIR}\n`)
    writeFileSync(join(dir, 'keep.json'), '{}\n')
    age(staleRoot, EXEC_CWD_MAX_AGE_MS * 2)
    age(staleNested, EXEC_CWD_MAX_AGE_MS * 2)

    expect(sweepExecCwdMarkers(DIR)).toBe(2)

    const rootLeft = readdirSync(DIR).filter((f) => f.startsWith(EXEC_CWD_PREFIX))
    expect(rootLeft).toEqual([freshRoot.slice(DIR.length + 1)])
    expect(readdirSync(dir).sort()).toEqual(['keep.json', freshNested.slice(dir.length + 1)].sort())
  })

  test('sweep is a no-op on a workspace with no markers', () => {
    expect(sweepExecCwdMarkers(DIR)).toBe(0)
    expect(sweepExecCwdMarkers(join(DIR, 'missing'))).toBe(0)
  })
})
