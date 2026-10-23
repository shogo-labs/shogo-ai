// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The single predicate for "this path is Shogo's own runtime state, not the
 * user's source", plus the git helpers that keep such paths out of a
 * checkpoint repo.
 *
 * Why this module exists (SHO-105, #1597): every per-turn checkpoint staged the
 * whole workspace with `git add -A`, and `.shogo/sessions.db`/`-wal`/`-shm`,
 * `.shogo/logs/*`, `.shogo/tasks/*.log` and `.shogo-cwd-*` scratch files were
 * in that tree. Ignore rules never apply to already-tracked paths, so once the
 * seed commit picked them up nothing untracked them. Worse, `autoTrackLargeFiles`
 * then appended a path-specific `filter=lfs` rule to `.gitattributes` for the
 * multi-megabyte SQLite files, so every turn wrote a brand-new LFS object with no
 * delta compression — 165 GB of `.git/lfs` on one Windows install.
 *
 * Everything here is idempotent and cheap-when-clean: one `git ls-files` per
 * call in the steady state.
 *
 * `.shogo/memory-history/**` is the one exception under `.shogo/`: it is agent
 * memory the user can inspect, and it is small text. `.shogo/plans/**` is not
 * kept — plans are rows in the database, the files are scratch output.
 */

import { spawn } from './child-process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

type Logger = Pick<Console, 'log' | 'warn' | 'error'>

/** The one subtree under `.shogo/` that is real, user-visible content. */
export const SHOGO_MEMORY_HISTORY_PREFIX = '.shogo/memory-history/'

/** Marker lines around the managed block in `.git/info/exclude`. */
export const SHOGO_EXCLUDE_HEADER = '# >>> shogo checkpoint excludes (managed) >>>'
export const SHOGO_EXCLUDE_FOOTER = '# <<< shogo checkpoint excludes (managed) <<<'

/**
 * Rules inside the managed exclude block. `.git/info/exclude` is used rather
 * than `.gitignore` on purpose: it cannot collide with a file the user tracks,
 * it covers a repo that has no `.gitignore` at all (1,088 of 1,091 repos on the
 * machine where this was reproduced), and editing it never dirties the tree.
 */
export const SHOGO_EXCLUDE_LINES: readonly string[] = [
  '.shogo/*',
  '!.shogo/memory-history/',
  '.shogo-cwd-*',
  '.tmp/',
  // A live/transient SQLite file is never source. Untracking stays narrow (only
  // under `.shogo`/`.tmp`/`.shogo-cwd-*`) so a fixture the user already tracks
  // keeps working; this end only stops *new* ones being picked up.
  '*.db',
  '*.db-wal',
  '*.db-shm',
  '*.db-journal',
]

/** Suffixes that only ever belong to a live or transient database file. */
const DB_SUFFIXES = ['.db', '.db-wal', '.db-shm', '.db-journal'] as const

/** Top-level specs the index-untrack pass looks at. */
const UNTRACK_SPECS = ['.shogo', '.tmp', '.shogo-cwd-*'] as const

const STALE_LOCK_MS = 5_000

/** `dir`'s lock file names checked by {@link isRepoIdle}. */
const REPAIR_LOCK = 'shogo-repair.lock'

export function toPosixPath(p: string): string {
  return p.split('\\').join('/')
}

/**
 * True when `relPath` (repo-relative, either separator) is Shogo runtime state
 * that must never be committed, tracked or LFS-stored.
 */
export function isShogoRuntimeState(relPath: string): boolean {
  const rel = toPosixPath(relPath).replace(/^\.\//, '').replace(/^\/+/, '')
  if (!rel) return false

  if (rel.startsWith('.shogo/')) return !rel.startsWith(SHOGO_MEMORY_HISTORY_PREFIX)
  if (rel.startsWith('.tmp/')) return true

  const base = rel.slice(rel.lastIndexOf('/') + 1)
  if (base.startsWith('.shogo-cwd-')) return true
  const lower = base.toLowerCase()
  return DB_SUFFIXES.some((suffix) => lower.endsWith(suffix))
}

/** Recursive on-disk size in bytes. Missing paths are 0. Links are not followed. */
export function directorySizeBytes(target: string): number {
  let total = 0
  const walk = (dir: string) => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      try {
        if (entry.isDirectory()) walk(abs)
        else if (entry.isFile()) total += statSync(abs).size
      } catch {
        /* a file being rewritten mid-walk — skip it */
      }
    }
  }
  walk(target)
  return total
}

// ---------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------

interface GitResult {
  exitCode: number
  stdout: string
  stderr: string
}

function run(dir: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: dir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf-8')
    child.stderr?.setEncoding('utf-8')
    child.stdout?.on('data', (c: string) => { stdout += c })
    child.stderr?.on('data', (c: string) => { stderr += c })
    child.on('error', reject)
    child.on('close', (code) => resolve({ exitCode: code ?? -1, stdout, stderr }))
  })
}

/**
 * The repo's git dir, without spawning git: `.git` is a directory for every repo
 * Shogo creates, and a `gitdir: <path>` file inside a worktree.
 */
export function resolveGitDir(repoDir: string): string | null {
  const dotGit = join(repoDir, '.git')
  let stat
  try {
    stat = statSync(dotGit)
  } catch {
    return null
  }
  if (stat.isDirectory()) return dotGit
  try {
    const line = readFileSync(dotGit, 'utf-8').split('\n')[0] ?? ''
    const match = /^gitdir:\s*(.+)$/.exec(line.trim())
    if (!match) return null
    const target = match[1].trim()
    return target.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(target)
      ? target
      : join(repoDir, target)
  } catch {
    return null
  }
}

function isGitRepo(repoDir: string): boolean {
  return resolveGitDir(repoDir) !== null
}

/**
 * Remove `gitDir`'s lock file when it is clearly abandoned (older than
 * `maxAgeMs`). A stale `index.lock` from a killed process makes every later
 * stage→commit fail, and each failed LFS attempt orphans another object. A
 * live lock is left alone.
 *
 * Returns true when a lock was removed.
 */
export function evictStaleGitLock(
  repoDir: string,
  maxAgeMs: number = STALE_LOCK_MS,
  log: Logger = console,
): boolean {
  const gitDir = resolveGitDir(repoDir)
  if (!gitDir) return false
  let removed = false
  for (const name of ['index.lock', REPAIR_LOCK]) {
    const lockPath = join(gitDir, name)
    let stat
    try {
      stat = statSync(lockPath)
    } catch {
      continue
    }
    const ageMs = Date.now() - stat.mtimeMs
    if (ageMs < maxAgeMs) continue
    try {
      unlinkSync(lockPath)
      removed = true
      log.warn(
        `[shogo-state] Removed stale .git/${name} (age ${Math.round(ageMs / 1000)}s) at ${repoDir}`,
      )
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        log.warn(`[shogo-state] Could not remove .git/${name}: ${err?.message ?? err}`)
      }
    }
  }
  return removed
}

/**
 * True when nothing else is writing to the repo: no live `index.lock`, no live
 * repair lock. Stale locks are evicted first, so a crashed process doesn't park
 * a repo out of repair forever.
 */
export function isRepoIdle(repoDir: string, log: Logger = console): boolean {
  const gitDir = resolveGitDir(repoDir)
  if (!gitDir) return false
  evictStaleGitLock(repoDir, STALE_LOCK_MS, log)
  return !existsSync(join(gitDir, 'index.lock')) && !existsSync(join(gitDir, REPAIR_LOCK))
}

/**
 * True while {@link acquireRepairLock}'s holder is rewriting this repo's refs.
 * Writers check it before staging: a commit that lands between the export and
 * the import would be discarded by the rewrite (its objects unreachable, its
 * `ProjectCheckpoint` row dangling), so it is cheaper to skip one turn — the
 * next turn commits the whole tree anyway.
 */
export function isRepairInProgress(
  repoDir: string,
  maxAgeMs: number = 10 * 60_000,
): boolean {
  const gitDir = resolveGitDir(repoDir)
  if (!gitDir) return false
  try {
    const stat = statSync(join(gitDir, REPAIR_LOCK))
    return Date.now() - stat.mtimeMs < maxAgeMs
  } catch {
    return false
  }
}

/**
 * Take the repair lock, or return null when another repair holds it. Released by
 * the returned function; a killed repair leaves a lock that
 * {@link evictStaleGitLock} clears on the next boot.
 */
export function acquireRepairLock(repoDir: string): (() => void) | null {
  const gitDir = resolveGitDir(repoDir)
  if (!gitDir) return null
  const lockPath = join(gitDir, REPAIR_LOCK)
  try {
    mkdirSync(join(gitDir, 'shogo'), { recursive: true })
    writeFileSync(lockPath, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' })
  } catch {
    return null
  }
  return () => {
    try {
      unlinkSync(lockPath)
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------
// .git/info/exclude
// ---------------------------------------------------------------------------

/** The managed block, exactly as it is written to `.git/info/exclude`. */
export function buildShogoExcludeBlock(): string {
  return [SHOGO_EXCLUDE_HEADER, ...SHOGO_EXCLUDE_LINES, SHOGO_EXCLUDE_FOOTER].join('\n')
}

/**
 * Write (or refresh) the managed exclude block in `<repo>/.git/info/exclude`,
 * preserving anything outside the markers. Returns true when the file changed.
 */
export function ensureShogoExcludes(repoDir: string, log: Logger = console): boolean {
  const gitDir = resolveGitDir(repoDir)
  if (!gitDir) return false
  const infoDir = join(gitDir, 'info')
  const excludePath = join(infoDir, 'exclude')
  let existing = ''
  try {
    existing = readFileSync(excludePath, 'utf-8')
  } catch {
    existing = ''
  }

  const start = existing.indexOf(SHOGO_EXCLUDE_HEADER)
  let stripped = existing
  if (start !== -1) {
    const end = existing.indexOf(SHOGO_EXCLUDE_FOOTER, start)
    stripped = end === -1
      ? existing.slice(0, start)
      : existing.slice(0, start) + existing.slice(end + SHOGO_EXCLUDE_FOOTER.length)
  }
  const rest = stripped.replace(/\n{3,}/g, '\n\n').trim()
  const next = [rest, buildShogoExcludeBlock()].filter(Boolean).join('\n\n') + '\n'
  if (next === existing) return false

  try {
    mkdirSync(infoDir, { recursive: true })
    writeFileSync(excludePath, next)
    return true
  } catch (err: any) {
    log.warn(`[shogo-state] could not write ${excludePath}: ${err?.message ?? err}`)
    return false
  }
}

// ---------------------------------------------------------------------------
// .gitattributes
// ---------------------------------------------------------------------------

/**
 * Drop LFS-track rules for Shogo runtime state from `.gitattributes`.
 *
 * `autoTrackLargeFiles` used to append `.shogo/sessions.db filter=lfs …` after
 * the file had already been committed, so the repo kept a rule that sent every
 * future version of a live SQLite database through LFS. The capture in
 * `classifyLargeFiles`/`autoTrackLargeFiles` stops new rules; this removes the
 * ones already written, so even a `git add -f` cannot re-introduce the bloat.
 *
 * Returns true when the file changed.
 */
export function stripShogoLfsRules(repoDir: string, log: Logger = console): boolean {
  const attrPath = join(repoDir, '.gitattributes')
  let existing: string
  try {
    existing = readFileSync(attrPath, 'utf-8')
  } catch {
    return false
  }
  const kept: string[] = []
  let removed = 0
  for (const line of existing.split('\n')) {
    const match = /^(\S+)\s+filter=lfs\b/.exec(line)
    if (match && isShogoRuntimeState(match[1])) {
      removed += 1
      continue
    }
    kept.push(line)
  }
  if (removed === 0) return false
  const next = kept.join('\n')
  try {
    writeFileSync(attrPath, next)
  } catch (err: any) {
    log.warn(`[shogo-state] could not rewrite ${attrPath}: ${err?.message ?? err}`)
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// index untracking
// ---------------------------------------------------------------------------

export interface UntrackResult {
  /** Count of paths removed from the index. */
  removed: number
  /** Paths removed from the index (repo-relative, posix). */
  paths: string[]
}

/**
 * Drop Shogo runtime state from the git *index* — files stay on disk. `-f` with
 * `--cached` bypasses the up-to-date check without ever touching the working
 * tree, so a memory-mapped `sessions.db-shm` cannot fail the pass.
 *
 * Idempotent: one `git ls-files` when the repo is already clean.
 */
export async function untrackShogoStatePaths(
  repoDir: string,
  opts: { logger?: Logger; batchSize?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<UntrackResult> {
  const log = opts.logger ?? console
  const batchSize = opts.batchSize && opts.batchSize > 0 ? opts.batchSize : 200
  const env = opts.env ?? process.env

  try {
    const listed = await run(repoDir, ['ls-files', '-z', '--', ...UNTRACK_SPECS], env)
    if (listed.exitCode !== 0 || !listed.stdout) return { removed: 0, paths: [] }

    const tracked = listed.stdout.split('\0').filter(Boolean)
    const doomed = tracked.filter((p) => isShogoRuntimeState(p))
    if (doomed.length === 0) return { removed: 0, paths: [] }

    evictStaleGitLock(repoDir, STALE_LOCK_MS, log)

    let removed = 0
    for (let i = 0; i < doomed.length; i += batchSize) {
      const batch = doomed.slice(i, i + batchSize)
      const res = await run(repoDir, [
        'rm', '-f', '-q', '-r', '--cached', '--ignore-unmatch', '--', ...batch,
      ], env)
      if (res.exitCode === 0) {
        removed += batch.length
      } else {
        log.warn(
          `[shogo-state] git rm --cached failed in ${repoDir} (${res.exitCode}): ${res.stderr.trim().slice(0, 300)}`,
        )
      }
    }

    // Keep the exception in the index so `.shogo/memory-history/**` stays tracked
    // even where `.git/info/exclude`'s `!.shogo/memory-history/` re-inclusion is
    // not applied (an exclude file cannot resurrect a path an ignore rule hides).
    if (!opts.env) {
      stripShogoLfsRules(repoDir, log)
    }
    if (!opts.env && existsSync(join(repoDir, '.shogo', 'memory-history'))) {
      await run(repoDir, ['add', '-A', '--', SHOGO_MEMORY_HISTORY_PREFIX], env)
    }

    return { removed, paths: doomed }
  } catch (err: any) {
    // Called before every stage on the checkpoint path: a repo that has gone
    // away, or a git that cannot spawn, must never abort a turn's commit.
    log.warn(`[shogo-state] untracking runtime state failed in ${repoDir}: ${err?.message ?? err}`)
    return { removed: 0, paths: [] }
  }
}

/**
 * The one call every writer makes before it stages: evict an abandoned lock,
 * install the exclude rules, drop runtime state from the index. Returns the
 * number of paths untracked (0 in the steady state).
 */
export async function prepareCheckpointRepo(
  repoDir: string,
  opts: { logger?: Logger } = {},
): Promise<number> {
  const log = opts.logger ?? console
  if (!isGitRepo(repoDir)) return 0
  evictStaleGitLock(repoDir, STALE_LOCK_MS, log)
  ensureShogoExcludes(repoDir, log)
  const { removed } = await untrackShogoStatePaths(repoDir, { logger: log })
  if (removed > 0) {
    log.log(`[shogo-state] untracked ${removed} runtime-state path(s) in ${repoDir}`)
  }
  return removed
}
