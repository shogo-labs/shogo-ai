// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A git child that exits before it reads stdin must not become an exception.
 *
 * `lfsTrackedPaths` feeds its path list to `git check-attr --stdin`, and git
 * exits before reading any of it in the ordinary case of a directory that is
 * not a repository (`fatal: not a git repository`), or when the path list is
 * empty enough for git to finish first. The pending write then fails with
 * EPIPE, and an unhandled `'error'` on that stream is an uncaught exception —
 * on Linux it arrives as a next-tick throw and takes down whatever the event
 * loop was running at the time (in CI it killed the publish-artifact test that
 * calls this, right after its request came back).
 *
 * macOS passes this even without the fix: the write wins the race against git's
 * exit there, so the error never reaches the loop. The Linux CI shard is where
 * this test has teeth, which is why the path list is far larger than a pipe
 * buffer — a write that cannot complete makes the race unwinnable.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lfsTrackedPaths } from '../lfs'

let dir: string

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('lfsTrackedPaths over a git child that dies early', () => {
  it('returns an empty set when the directory is not a repository, even for a write too big for a pipe', async () => {
    dir = mkdtempSync(join(tmpdir(), 'shogo-lfs-stdin-'))
    const paths = Array.from({ length: 20_000 }, (_, i) => `src/f${i}.bin`)
    const tracked = await lfsTrackedPaths(dir, paths)
    expect(tracked.size).toBe(0)
    // Give the EPIPE that the failed write produces a chance to surface: before
    // the fix this is where the uncaught throw landed.
    await new Promise((resolve) => setTimeout(resolve, 50))
  })

  it('still resolves the paths a real .gitattributes marks as LFS', async () => {
    dir = mkdtempSync(join(tmpdir(), 'shogo-lfs-stdin-'))
    execFileSync('git', ['init', '--quiet'], { cwd: dir })
    writeFileSync(join(dir, '.gitattributes'), '*.mp4 filter=lfs diff=lfs merge=lfs -text\n')
    mkdirSync(join(dir, 'media'), { recursive: true })
    writeFileSync(join(dir, 'media', 'clip.mp4'), 'not really a video')
    writeFileSync(join(dir, 'note.txt'), 'plain')

    const tracked = await lfsTrackedPaths(dir, ['media/clip.mp4', 'note.txt'])
    expect([...tracked]).toEqual(['media/clip.mp4'])
  })
})
