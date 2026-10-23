// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-105 / #1597 — reclaiming the history already on disk.
 *
 * Runs on real temp repos with real Git LFS: a 20-commit repo where every
 * commit carries a 6 MB `.shogo/sessions.db` (LFS-tracked, like the reported
 * 165 GB install), a `.shogo/memory-history` file that must survive, and a real
 * source file that must come out byte-identical.
 */
import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import {
  filterExportStream,
  parseMarks,
  readRepairMarker,
  repairCheckpointRepo,
} from '../checkpoint-repo-repair'
import { directorySizeBytes } from '../shogo-state-paths'

const quiet = { log: () => {}, warn: () => {}, error: () => {} }

function hasLfs(): boolean {
  try {
    execFileSync('git', ['lfs', 'version'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

const LFS = hasLfs()

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function gitOk(cwd: string, ...args: string[]): boolean {
  try {
    execFileSync('git', args, { cwd, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shogo-repair-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'pipe' })
  git(dir, 'config', 'user.name', 'Shogo Agent')
  git(dir, 'config', 'user.email', 'agent@shogo.ai')
  git(dir, 'config', 'commit.gpgsign', 'false')
  return dir
}

/** 20 commits, each rewriting a 6 MB `.shogo/sessions.db` plus real source. */
function buildBloatedRepo(dir: string): { dbBytes: number } {
  execFileSync('git', ['lfs', 'install', '--local', '--skip-smudge'], { cwd: dir, stdio: 'pipe' })
  writeFileSync(
    join(dir, '.gitattributes'),
    '.shogo/sessions.db filter=lfs diff=lfs merge=lfs -text\n' +
      '*.bin filter=lfs diff=lfs merge=lfs -text\n'
  )
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, '.shogo', 'memory-history'), { recursive: true })
  writeFileSync(join(dir, 'src', 'app.ts'), 'export const answer = 42\n')
  writeFileSync(join(dir, '.shogo', 'memory-history', '2026-10-21.md'), '# day one\n')
  const chunk = 'x'.repeat(1024 * 1024)
  for (let i = 0; i < 20; i++) {
    writeFileSync(join(dir, '.shogo', 'sessions.db'), `${chunk}${i}`)
    writeFileSync(join(dir, 'src', `file-${i}.ts`), `export const v = ${i}\n`)
    git(dir, 'add', '-A')
    execFileSync('git', ['commit', '-q', '-m', `commit ${i}`, '--no-verify'], {
      cwd: dir,
      stdio: 'pipe',
    })
  }
  return { dbBytes: 6 * 1024 * 1024 }
}

describe('filterExportStream', () => {
  test('drops M/D/C/R lines for runtime state and keeps everything else', () => {
    const stream = [
      'commit refs/heads/main',
      'mark :1',
      'data 3',
      'one',
      'M 100644 :2 src/app.ts',
      'M 100644 :3 .shogo/sessions.db',
      "M 100644 :4 .tmp/shot.png",
      'D .shogo/logs/console.log',
      'M 100644 :5 .shogo/memory-history/x.md',
      'M 100644 :6 prisma/dev.db',
      'R ".shogo/sessions.db" "src/legacy.ts"',
      '',
    ].join('\n')
    const { out: outBuf, dropped } = filterExportStream(stream)
    const out = outBuf.toString('utf8')
    // sessions.db, .tmp/shot.png, the log delete, prisma/dev.db (*.db) and the rename
    expect(dropped).toBe(5)
    expect(out).toContain('M 100644 :2 src/app.ts')
    expect(out).toContain('M 100644 :5 .shogo/memory-history/x.md')
    expect(out).not.toContain('prisma/dev.db')
    expect(out).not.toContain('sessions.db')
    expect(out).not.toContain('.tmp/shot.png')
    // The commit header itself is untouched.
    expect(out).toContain('commit refs/heads/main')
  })

  test('parseMarks reads fast-export mark files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shogo-marks-'))
    try {
      const file = join(dir, 'marks')
      writeFileSync(file, ':1 ' + 'a'.repeat(40) + '\n:2 ' + 'b'.repeat(40) + '\n')
      const marks = parseMarks(file)
      expect(marks.get('1')).toBe('a'.repeat(40))
      expect(marks.get('2')).toBe('b'.repeat(40))
      expect(parseMarks(join(dir, 'missing')).size).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('repairCheckpointRepo', () => {
  test('is a no-op on a repo with no runtime state in history', async () => {
    const dir = initRepo()
    try {
      writeFileSync(join(dir, 'index.ts'), 'export {}\n')
      git(dir, 'add', '-A')
      execFileSync('git', ['commit', '-q', '-m', 'clean', '--no-verify'], { cwd: dir, stdio: 'pipe' })
      const head = git(dir, 'rev-parse', 'HEAD')
      const result = await repairCheckpointRepo(dir, { logger: quiet })
      expect(result.reason).toBe('clean-history')
      expect(git(dir, 'rev-parse', 'HEAD')).toBe(head)
      expect(readRepairMarker(dir)).not.toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('dry run reports what it would drop and changes nothing', async () => {
    const dir = initRepo()
    try {
      writeFileSync(join(dir, 'index.ts'), 'export {}\n')
      mkdirSync(join(dir, '.shogo'), { recursive: true })
      writeFileSync(join(dir, '.shogo', 'sessions.db'), 'x')
      git(dir, 'add', '-A')
      execFileSync('git', ['commit', '-q', '-m', 'dirty', '--no-verify'], { cwd: dir, stdio: 'pipe' })
      const head = git(dir, 'rev-parse', 'HEAD')
      const result = await repairCheckpointRepo(dir, { logger: quiet, dryRun: true })
      expect(result.reason).toContain('dry-run')
      expect(git(dir, 'rev-parse', 'HEAD')).toBe(head)
      expect(readRepairMarker(dir)).toBeNull()
      expect(git(dir, 'ls-files', '--', '.shogo')).toContain('.shogo/sessions.db')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test.skipIf(!LFS)(
    'drops every .shogo/sessions.db from every ref, keeps memory-history and the working tree, and shrinks .git/lfs',
    async () => {
      const dir = initRepo()
      try {
        buildBloatedRepo(dir)
        const headBefore = git(dir, 'rev-parse', 'HEAD')
        const sourceBefore = git(dir, 'show', 'HEAD:src/file-19.ts')
        const statusBefore = execFileSync('git', ['status', '--porcelain'], {
          cwd: dir,
          encoding: 'utf8',
        })
        const lfsBefore = directorySizeBytes(join(dir, '.git', 'lfs'))
        const versionsBefore = git(dir, 'lfs', 'ls-files', '-a').split('\n').filter(Boolean).length
        expect(lfsBefore).toBeGreaterThan(20 * 1024 * 1024)

        const remapped = new Map<string, string>()
        const result = await repairCheckpointRepo(dir, {
          logger: quiet,
          onRemap: (map) => {
            for (const [from, to] of map) remapped.set(from, to)
          },
        })

        expect(result.skipped).toBe(false)
        expect(result.rewritten).toBeGreaterThan(0)
        expect(remapped.size).toBe(result.rewritten)

        // AC 6 — no ref carries the DB any more, memory-history survives in all.
        expect(git(dir, 'log', '--all', '--format=%H', '--', '.shogo/sessions.db')).toBe('')
        const allCommits = git(dir, 'rev-list', '--all').split('\n').filter(Boolean)
        expect(allCommits.length).toBe(20)
        for (const sha of allCommits) {
          expect(
            git(dir, 'ls-tree', '-r', '--name-only', sha, '--', '.shogo/memory-history')
          ).toBe('.shogo/memory-history/2026-10-21.md')
        }

        // The real source tree is byte-identical at HEAD.
        const headAfter = git(dir, 'rev-parse', 'HEAD')
        expect(headAfter).not.toBe(headBefore)
        expect(remapped.get(headBefore)).toBe(headAfter)
        expect(git(dir, 'show', 'HEAD:src/file-19.ts')).toBe(sourceBefore)

        // AC 6/7 — every dropped path is untracked, none deleted from disk.
        expect(git(dir, 'ls-files', '--', '.shogo')).toBe('.shogo/memory-history/2026-10-21.md')
        expect(existsSync(join(dir, '.shogo', 'sessions.db'))).toBe(true)
        // AC 7 — no file on disk was touched. The only new status entry is
        // `.gitattributes`, because the repair also strips the stale
        // `.shogo/sessions.db filter=lfs` rule that caused the bloat.
        const statusAfter = execFileSync('git', ['status', '--porcelain'], {
          cwd: dir,
          encoding: 'utf8',
        })
        const before = new Set(statusBefore.split('\n').filter(Boolean))
        const introduced = statusAfter
          .split('\n')
          .filter(Boolean)
          .filter((line) => !before.has(line))
        expect(introduced).toEqual([' M .gitattributes'])
        expect(readFileSync(join(dir, '.gitattributes'), 'utf-8')).not.toContain(
          '.shogo/sessions.db'
        )
        // …and every rule that isn't runtime state survives untouched.
        expect(readFileSync(join(dir, '.gitattributes'), 'utf-8')).toContain(
          '*.bin filter=lfs'
        )

        // AC 6 — LFS reclaimed, marker written.
        const lfsAfter = directorySizeBytes(join(dir, '.git', 'lfs'))
        const versionsAfter = git(dir, 'lfs', 'ls-files', '-a').split('\n').filter(Boolean).length
        expect(lfsAfter).toBeLessThan(lfsBefore * 0.2)
        expect(versionsAfter).toBeLessThan(versionsBefore * 0.2)
        const marker = readRepairMarker(dir)!
        expect(marker.version).toBe(1)
        expect(Number(marker.bytesAfter)).toBeLessThan(Number(marker.bytesBefore))

        // AC 6 — a second run changes nothing at all.
        const second = await repairCheckpointRepo(dir, { logger: quiet })
        expect(second.reason).toBe('already-repaired')
        expect(git(dir, 'rev-parse', 'HEAD')).toBe(headAfter)
        expect(directorySizeBytes(join(dir, '.git', 'lfs'))).toBe(lfsAfter)

        // The backup bundle exists and is a valid repo image.
        const backups = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: dir, encoding: 'utf8' }).trim()
        const backupDir = join(dir, backups, 'shogo', 'backups')
        expect(existsSync(backupDir)).toBe(true)
        expect(statSync(backupDir).isDirectory()).toBe(true)
        // AC 6 — every checkpoint sha maps to a commit that still resolves.
        for (const [from, to] of remapped) {
          expect(gitOk(dir, 'cat-file', '-e', `${to}^{commit}`)).toBe(true)
          expect(from).not.toBe(to)
        }
        // memory-history content is intact.
        expect(readFileSync(join(dir, '.shogo', 'memory-history', '2026-10-21.md'), 'utf-8')).toBe(
          '# day one\n'
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    120_000
  )

  test('keeps blob payloads byte-identical when they contain git-fast-export-looking lines', async () => {
    const dir = initRepo()
    try {
      // A payload line that looks exactly like a file change must not be
      // mistaken for one: the filter copies `data <n>` by declared length.
      const tricky = Buffer.from(
        'M 100644 :3 looks-like-a-change.ts\nD .shogo/sessions.db\ndata 12\nmé, dónde\n'
      )
      writeFileSync(join(dir, 'tricky.txt'), tricky)
      mkdirSync(join(dir, '.shogo'), { recursive: true })
      writeFileSync(join(dir, '.shogo', 'sessions.db'), 'db')
      git(dir, 'add', '-A')
      execFileSync('git', ['commit', '-q', '-m', 'payload with traps', '--no-verify'], {
        cwd: dir,
        stdio: 'pipe',
      })

      const result = await repairCheckpointRepo(dir, { logger: quiet })
      expect(result.rewritten).toBe(1)
      const after = execFileSync('git', ['cat-file', '-p', 'HEAD:tricky.txt'], { cwd: dir })
      expect(Buffer.compare(after, tricky)).toBe(0)
      expect(git(dir, 'log', '--all', '--format=%H', '--', '.shogo/sessions.db')).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('is skipped while the repo is busy', async () => {
    const dir = initRepo()
    try {
      writeFileSync(join(dir, 'index.ts'), 'export {}\n')
      mkdirSync(join(dir, '.shogo'), { recursive: true })
      writeFileSync(join(dir, '.shogo', 'sessions.db'), 'x')
      git(dir, 'add', '-A')
      execFileSync('git', ['commit', '-q', '-m', 'dirty', '--no-verify'], { cwd: dir, stdio: 'pipe' })
      writeFileSync(join(dir, '.git', 'index.lock'), '')
      const result = await repairCheckpointRepo(dir, { logger: quiet })
      expect(result.reason).toBe('busy')
      expect(readRepairMarker(dir)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
