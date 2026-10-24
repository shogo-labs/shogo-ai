// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance for SHO-105 / #1597, seed path.
 *
 * The root cause on a machine with 1 091 checkpoint repos was that 1 088 of
 * them had no `.gitignore`, so `seedRepoIfAbsent`'s first `git add -A`
 * committed `.shogo/sessions.db` (plus its memory-mapped `-wal`/`-shm`), the
 * logs, the task output and `.shogo-cwd-*` scratch files — and ignore rules
 * never apply to an already-tracked path. This enters through the production
 * seed call, not the helpers, because the wiring is what was missing.
 *
 * (`apps/api`'s test preload stubs `@shogo/shared-runtime` wholesale, so this
 * lives here, next to the module under test.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { seedRepoIfAbsent } from '../repo-store'

const quiet = { log: () => {}, warn: () => {}, error: () => {} }
const MEMORY_HISTORY = '.shogo/memory-history/2026-10-21.md'

let tmpRoot: string

function write(dir: string, rel: string, body: string | Buffer = '') {
  const abs = join(dir, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, body as any)
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: 'pipe' }).trim()
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'qa-sho105-seed-'))
})

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('seedRepoIfAbsent — a new checkpoint repo never starts tracking runtime state', () => {
  it('no .gitignore at all: the seed commit carries only source and memory-history', async () => {
    const dir = join(tmpRoot, 'no-gitignore')
    mkdirSync(dir, { recursive: true })
    write(dir, 'src/app.ts', 'export const x = 1\n')
    write(dir, MEMORY_HISTORY, '# memory\n')
    write(dir, '.shogo/sessions.db', Buffer.alloc(6 * 1024 * 1024, 7))
    write(dir, '.shogo/sessions.db-wal', 'wal\n')
    write(dir, '.shogo/sessions.db-shm', 'shm\n')
    write(dir, '.shogo/logs/console.log', 'log\n')
    write(dir, '.shogo/tasks/turn-1.log', 'task\n')
    write(dir, '.shogo-cwd-4f2a.json', '{}\n')
    write(dir, '.tmp/scratch.json', '{}\n')
    expect(existsSync(join(dir, '.gitignore'))).toBe(false)

    const sha = await seedRepoIfAbsent(dir, { logger: quiet })
    expect(sha).toBeTruthy()

    const tracked = git(dir, 'ls-files').split('\n').filter(Boolean)
    expect(tracked).toContain('src/app.ts')
    expect(tracked).toContain(MEMORY_HISTORY)
    expect(tracked.filter((p) => p.startsWith('.shogo/'))).toEqual([MEMORY_HISTORY])
    expect(tracked.filter((p) => p.startsWith('.tmp/'))).toEqual([])
    expect(tracked.filter((p) => p.includes('.shogo-cwd-'))).toEqual([])

    // Nothing deleted from disk — only kept out of the index.
    expect(existsSync(join(dir, '.shogo', 'sessions.db'))).toBe(true)
    expect(existsSync(join(dir, '.shogo', 'sessions.db-wal'))).toBe(true)
    expect(existsSync(join(dir, '.tmp', 'scratch.json'))).toBe(true)

    // AC 4 — covered without touching `.gitignore` at all.
    expect(existsSync(join(dir, '.gitignore'))).toBe(false)
    expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf-8')).toContain(
      '# >>> shogo checkpoint excludes (managed) >>>'
    )
    expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf-8')).toContain(
      '!.shogo/memory-history/'
    )

    // …and no LFS object for the 6 MB database (this is the 165 GB mechanism).
    expect(existsSync(join(dir, '.git', 'lfs', 'objects'))).toBe(false)
    expect(existsSync(join(dir, '.gitattributes'))).toBe(false)

    // The seed commit itself is clean, not just the index.
    const tree = git(dir, 'ls-tree', '-r', '--name-only', sha!)
    expect(tree.split('\n').filter((p) => p.startsWith('.shogo/'))).toEqual([MEMORY_HISTORY])
  })

  it('a user .gitignore is left as the user wrote it', async () => {
    const dir = join(tmpRoot, 'user-gitignore')
    mkdirSync(dir, { recursive: true })
    write(dir, '.gitignore', 'dist/\n.env\n')
    write(dir, 'src/app.ts', 'export const y = 2\n')
    write(dir, MEMORY_HISTORY, '# memory\n')
    write(dir, '.shogo/sessions.db', 'db\n')

    await seedRepoIfAbsent(dir, { logger: quiet })

    expect(readFileSync(join(dir, '.gitignore'), 'utf-8')).toBe('dist/\n.env\n')
    const tracked = git(dir, 'ls-files').split('\n').filter(Boolean)
    expect(tracked.filter((p) => p.startsWith('.shogo/'))).toEqual([MEMORY_HISTORY])
  })
})
