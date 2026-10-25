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
 * digest. The agent's own bookkeeping (`MEMORY.md`, `memory/`, plans under
 * `.shogo/`, uploads under `files/`) is excluded — no bundler reads it, and
 * it is what an idle agent writes most.
 */
import { createHash } from 'crypto'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'

const STATE_FILE = 'build-input-fingerprint'

/** Directories no build consumes, at any depth. */
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
])

/** Root-level files that are agent bookkeeping rather than app source. */
const IGNORED_FILES = new Set(['MEMORY.md', 'TOOLS.md', 'AGENTS.md', 'HEARTBEAT.md', 'WORKSPACE.md', 'STACK.md'])

function isIgnored(relativePath: string, isDir: boolean): boolean {
  const parts = relativePath.split('/')
  const name = parts[parts.length - 1]
  if (isDir) {
    if (IGNORED_DIRS.has(name)) return true
    // Build output: dist, dist.prev, dist.staging, dist-ios, …
    return name === 'dist' || name.startsWith('dist.') || name.startsWith('dist-')
  }
  if (name.startsWith('.memory-index.db')) return true
  return parts.length === 1 && IGNORED_FILES.has(name)
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
export function fingerprintBuildInputs(workspaceDir: string): string | null {
  const digest = createHash('sha1')
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
      const absolutePath = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!isIgnored(relativePath, true)) walk(absolutePath, relativePath)
        continue
      }
      // Symlinks are skipped: `entry.isFile()` is false for them, and a linked
      // tree (node_modules is usually one) is not this workspace's source.
      if (!entry.isFile() || isIgnored(relativePath, false)) continue
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
 */
export function consumeBuildInputChange(workspaceDir: string): boolean {
  const fingerprint = fingerprintBuildInputs(workspaceDir)
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
