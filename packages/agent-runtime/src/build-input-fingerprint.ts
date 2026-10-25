// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Whether a rebuild of a **metro** (`expo export`) or **static-build** workspace
 * changed what it serves — the question the canvas "Update available · Refresh"
 * toast asks before it interrupts the user.
 *
 * Vite stacks answer it from the build itself: `build-output-prune`'s plugin
 * fingerprints the transformed module source at `writeBundle`. These stacks
 * can't. Their emitters are not byte-stable across two runs over identical
 * sources, so a fingerprint of the output would differ on every rebuild and
 * the gate would never suppress anything. Measured with two real
 * `expo export --platform web` runs on an unchanged managed expo-app: module
 * ids are assigned in traversal order, so the bundle, its hashed filename and
 * therefore `index.html` all move (`entry-700b2da4….js` → `entry-29731e11….js`).
 *
 * So for these paths the fingerprint covers the *inputs* a build can consume.
 * Unchanged inputs mean the rebuild reproduced the previous site, which is
 * exactly the case that must not raise the toast; any real edit lands in the
 * digest. "Input" is the whole difficulty: a real project directory also
 * contains the running app's dev database, the agent's scratch files, editor
 * droppings and the build's own output. Anything in here that no build reads
 * must be excluded, or *using* the app arms the toast for the next rebuild with
 * no code change — the symptom this module exists to stop. Hence
 * `BuildInputFingerprintOptions.ignore`: the caller passes its resolved output
 * directories, because a `custom` static stack may build to `build/` rather
 * than `dist/`.
 */
import { createHash } from 'crypto'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'

const STATE_FILE = 'build-input-fingerprint'

/**
 * Directories no build consumes, at any depth. `prisma` is left alone at
 * directory level (a build can import generated types from it) — only the dev
 * database files inside it are excluded, see `isIgnoredFile`.
 */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.shogo',
  '.expo',
  '.astro',
  '.cache',
  'coverage',
  'memory',
  'files',
  '.tmp',
  '.cursor',
  '__tests__',
])

/** Root-level files that are agent bookkeeping rather than app source. */
const IGNORED_ROOT_FILES = new Set(['MEMORY.md', 'TOOLS.md', 'AGENTS.md', 'HEARTBEAT.md', 'WORKSPACE.md', 'STACK.md'])

function isIgnoredDir(relativePath: string): boolean {
  const parts = relativePath.split('/')
  const name = parts[parts.length - 1]
  if (IGNORED_DIRS.has(name)) return true
  // A screenshot/test-run directory and the e2e harness are never served.
  if (name === 'e2e') return true
  // Build output: dist, dist.prev, dist.staging, dist-ios, …
  return name === 'dist' || name.startsWith('dist.') || name.startsWith('dist-')
}

function isIgnoredFile(relativePath: string): boolean {
  const parts = relativePath.split('/')
  const name = parts[parts.length - 1]
  // Editor and OS droppings.
  if (name === '.DS_Store' || name === 'Thumbs.db') return true
  // The running app's own SQLite: written whenever the app is *used*, and no
  // build reads it. Matches dev.db, dev.db-wal, dev.db-shm and friends.
  if (/\.(db|sqlite|sqlite3)(-wal|-shm|-journal)?$/i.test(name)) return true
  if (name.startsWith('.memory-index.db')) return true
  // Tests are not served, and editing one should not claim a new build.
  if (/\.(test|spec)\.[^.]+$/i.test(name)) return true
  return parts.length === 1 && IGNORED_ROOT_FILES.has(name)
}

export interface BuildInputFingerprintOptions {
  /**
   * Output directories of this build, relative to the workspace (a resolved
   * `outDir` plus any staging dir). Their contents are output, never input.
   */
  ignore?: string[]
}

function normalizeIgnore(ignore: string[] | undefined): string[] {
  if (!ignore) return []
  return ignore
    .map((entry) => entry.replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, ''))
    .filter((entry) => entry.length > 0 && entry !== '.')
}

function isIgnoredByCaller(relativePath: string, ignore: string[]): boolean {
  for (const entry of ignore) {
    if (relativePath === entry || relativePath.startsWith(`${entry}/`)) return true
  }
  return false
}

/**
 * Content hash per absolute path, keyed by size + mtime so a rebuild re-reads
 * only the files that could have changed. Content (not mtime) is what goes in
 * the digest, so touching a file without editing it does not look like an
 * update.
 */
const fileHashes = new Map<string, { size: number; mtimeMs: number; hash: string }>()

function hashFile(absolutePath: string, size: number, mtimeMs: number): string {
  const cached = fileHashes.get(absolutePath)
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached.hash
  const hash = createHash('sha1').update(readFileSync(absolutePath)).digest('hex')
  fileHashes.set(absolutePath, { size, mtimeMs, hash })
  return hash
}

/**
 * Digest of every file a build in this workspace could consume, or `null` if
 * there is nothing to hash (callers treat that as "changed", so a real update
 * is never hidden).
 */
export function fingerprintBuildInputs(workspaceDir: string, options?: BuildInputFingerprintOptions): string | null {
  const digest = createHash('sha1')
  const ignore = normalizeIgnore(options?.ignore)
  let hashed = 0

  const walk = (dir: string, prefix: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (isIgnoredByCaller(relativePath, ignore)) continue
      const absolutePath = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!isIgnoredDir(relativePath)) walk(absolutePath, relativePath)
        continue
      }
      // Symlinks are skipped: `entry.isFile()` is false for them, and a linked
      // tree (node_modules is usually one) is not this workspace's source.
      if (!entry.isFile() || isIgnoredFile(relativePath)) continue
      let stat
      try {
        stat = statSync(absolutePath)
      } catch {
        continue
      }
      let hash: string
      try {
        hash = hashFile(absolutePath, stat.size, stat.mtimeMs)
      } catch {
        continue
      }
      digest.update(`${relativePath}\0${hash}\0`)
      hashed++
    }
  }

  walk(workspaceDir, '')
  return hashed === 0 ? null : digest.digest('hex')
}

/**
 * Whether a finished build should raise the canvas "Update available ·
 * Refresh" toast. One decision point for every build path: a build that does
 * not say anything about `outputChanged` is assumed to have changed something,
 * because hiding a real update is worse than a redundant toast.
 */
export function shouldReloadForBuild(info?: { outputChanged?: boolean }): boolean {
  return info?.outputChanged !== false
}

/**
 * Compare the current inputs against the last rebuild's and report whether the
 * served output changed. The first call for a workspace reports `true`.
 *
 * Pass the build's own output directories in `options.ignore` — otherwise the
 * build dirties its own inputs and every rebuild looks like an update.
 */
export function consumeBuildInputChange(workspaceDir: string, options?: BuildInputFingerprintOptions): boolean {
  const fingerprint = fingerprintBuildInputs(workspaceDir, options)
  if (!fingerprint) return true

  const statePath = join(workspaceDir, '.shogo', STATE_FILE)
  let previous: string | null = null
  try {
    previous = readFileSync(statePath, 'utf-8').trim() || null
  } catch {
    /* First build, or state is unreadable. */
  }

  try {
    mkdirSync(join(workspaceDir, '.shogo'), { recursive: true })
    writeFileSync(statePath, fingerprint)
  } catch {
    // If state cannot be persisted, keep notifying rather than hide changes.
    return true
  }

  return previous !== fingerprint
}
