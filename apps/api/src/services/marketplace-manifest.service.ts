// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * marketplace-manifest.service
 *
 * Per-file sha256 manifests used by the marketplace versioning + drift
 * detection flow (Phase 6 of the templates → marketplace consolidation).
 *
 * On install we capture `computeWorkspaceManifest(projectId)` and store
 * it on `MarketplaceInstall.baselineManifest`. When the listing publishes
 * a new version, `applyUpdate(installId)` recomputes the current manifest,
 * diffs it against the baseline, and refuses to overwrite diverged files
 * unless the caller passes `{ force: true }`.
 *
 * The shape — a flat `{ relPath: sha256-hex }` object — is intentionally
 * cheap to JSON-encode into a Postgres `jsonb` column; we never expect a
 * workspace to have more than a few thousand files post-filtering, and
 * each pair is ~80 bytes.
 *
 * The `MarketplaceListingVersion.workspaceSnapshot` shape (an object map
 * `{ relPath: string | { data: string; encoding: 'base64' | 'utf8' } }`)
 * is owned by `applyWorkspaceSnapshot` in `marketplace-install.service.ts`
 * — we read from it but never write it here. `computeSnapshotManifest`
 * below produces a manifest with byte-identical hashes to a workspace on
 * disk that was seeded from the same snapshot, so a freshly-applied
 * snapshot leaves an `installedVersion === currentVersion` install with
 * zero drift.
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { getWorkspacesDir } from './marketplace-install.service'

/**
 * Directory and filename segments excluded from the manifest. Mirrors
 * the `EXCLUDED_DIRS` list in `marketplace-install.service.ts` so a
 * fresh install + manifest produces the same set of paths the install's
 * own `cpSync` filter accepted. Adding `.install-*` here keeps the
 * partial-install sentinel directories out (these are recreated on every
 * fresh install and would otherwise show as drift).
 */
const EXCLUDED_SEGMENTS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.cache',
  '.next',
  'build',
  '.turbo',
  '.expo',
])

const EXCLUDED_FILE_NAMES = new Set([
  '.DS_Store',
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'yarn.lock',
])

function isExcludedSegment(segment: string): boolean {
  if (EXCLUDED_SEGMENTS.has(segment)) return true
  if (segment.startsWith('.install-')) return true
  return false
}

function isExcludedRelPath(rel: string): boolean {
  if (!rel) return true
  for (const segment of rel.split(/[/\\]/)) {
    if (segment === '' || segment === '.') continue
    if (isExcludedSegment(segment)) return true
  }
  const last = rel.split(/[/\\]/).pop() ?? ''
  if (EXCLUDED_FILE_NAMES.has(last)) return true
  return false
}

function sha256Hex(buf: Buffer | string): string {
  const hash = createHash('sha256')
  hash.update(typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf)
  return hash.digest('hex')
}

/**
 * Walk the on-disk workspace for `projectId` and return a manifest of
 * `relPath -> sha256(content)` for every non-excluded file.
 *
 * Synchronous fs APIs are used deliberately — this runs at install /
 * apply-update time (single-call scopes), and the existing
 * `copyWorkspaceFiles` walker uses `cpSync` which is itself sync, so
 * we'd buy nothing by going async here.
 */
export function computeWorkspaceManifest(projectId: string): Record<string, string> {
  const root = join(getWorkspacesDir(), projectId)
  if (!existsSync(root)) return {}
  const out: Record<string, string> = {}
  walkDir(root, root, out)
  return out
}

function walkDir(absDir: string, root: string, out: Record<string, string>): void {
  let entries: ReturnType<typeof readdirSync>
  try {
    entries = readdirSync(absDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const abs = join(absDir, entry.name)
    const rel = relative(root, abs)
    if (isExcludedRelPath(rel)) continue
    if (entry.isDirectory()) {
      walkDir(abs, root, out)
      continue
    }
    if (!entry.isFile()) continue
    try {
      const buf = readFileSync(abs)
      out[rel.split('\\').join('/')] = sha256Hex(buf)
    } catch {
      // Unreadable files (broken symlinks, permission denied) are silently
      // skipped — the install copy would have skipped them too.
    }
  }
}

/**
 * `MarketplaceListingVersion.workspaceSnapshot` shape. We accept either:
 *   - a flat `{ relPath: stringContent }` (utf8), or
 *   - a `{ relPath: { data: string, encoding: 'utf8' | 'base64' } }`,
 *   - or a wrapper `{ files: { ...same... } }`.
 *
 * `applyWorkspaceSnapshot` in marketplace-install.service.ts handles the
 * same three shapes. We mirror its decoding here so manifests match.
 */
export type WorkspaceSnapshot =
  | Record<string, string | { data: string; encoding?: string }>
  | { files: Record<string, string | { data: string; encoding?: string }> }

function decodeSnapshotEntry(val: unknown): Buffer | null {
  if (typeof val === 'string') {
    return Buffer.from(val, 'utf8')
  }
  if (val && typeof val === 'object') {
    const obj = val as { data?: unknown; encoding?: unknown }
    if (typeof obj.data === 'string') {
      const enc = obj.encoding === 'base64' ? 'base64' : 'utf8'
      return Buffer.from(obj.data, enc)
    }
  }
  return null
}

/**
 * Compute the same manifest shape from a `workspaceSnapshot` value as
 * `computeWorkspaceManifest` would produce for the resulting on-disk
 * tree. Used by tests + the migration script when seeding a baseline
 * before any disk write has happened.
 */
export function computeSnapshotManifest(snapshot: unknown): Record<string, string> {
  if (snapshot == null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return {}
  }
  const root = snapshot as Record<string, unknown>
  const fileMap =
    root.files != null && typeof root.files === 'object' && !Array.isArray(root.files)
      ? (root.files as Record<string, unknown>)
      : root

  const out: Record<string, string> = {}
  for (const [relPath, val] of Object.entries(fileMap)) {
    if (relPath === 'files') continue
    if (!relPath || relPath.includes('..') || relPath.startsWith('/')) continue
    if (isExcludedRelPath(relPath)) continue
    const decoded = decodeSnapshotEntry(val)
    if (!decoded) continue
    out[relPath.split('\\').join('/')] = sha256Hex(decoded)
  }
  return out
}

export interface ManifestDiff {
  added: string[]
  modified: string[]
  deleted: string[]
}

/**
 * Diff two manifests. `added` = present in `current` only;
 * `deleted` = present in `baseline` only; `modified` = same key, different hash.
 *
 * `current` represents the live workspace; `baseline` represents the state
 * captured at last install / apply-update. The terminology matches what we
 * surface to users in the drift dialog: "you added X, modified Y, deleted Z".
 */
export function diffManifests(
  baseline: Record<string, string> | null | undefined,
  current: Record<string, string> | null | undefined,
): ManifestDiff {
  const base = baseline ?? {}
  const cur = current ?? {}

  const added: string[] = []
  const modified: string[] = []
  const deleted: string[] = []

  for (const [path, hash] of Object.entries(cur)) {
    const baseHash = base[path]
    if (baseHash === undefined) {
      added.push(path)
    } else if (baseHash !== hash) {
      modified.push(path)
    }
  }
  for (const path of Object.keys(base)) {
    if (cur[path] === undefined) {
      deleted.push(path)
    }
  }

  added.sort()
  modified.sort()
  deleted.sort()

  return { added, modified, deleted }
}

/**
 * Read every file under `workspaces/<projectId>/` (subject to the same
 * exclusions used by `computeWorkspaceManifest`) and emit a snapshot in
 * the shape consumed by `applyWorkspaceSnapshot` and stored in
 * `MarketplaceListingVersion.workspaceSnapshot`. Used by the new
 * `POST /creator/listings/:id/versions` flow when the creator omits the
 * snapshot body — the server snapshots the source project for them.
 *
 * Binary files are encoded as base64 wrapper objects; text files are
 * stored as plain strings to keep snapshots reviewable in DB tooling.
 */
export function snapshotProjectWorkspace(
  projectId: string,
): Record<string, string | { data: string; encoding: 'base64' }> {
  const root = join(getWorkspacesDir(), projectId)
  if (!existsSync(root)) return {}
  const out: Record<string, string | { data: string; encoding: 'base64' }> = {}
  snapshotWalk(root, root, out)
  return out
}

function snapshotWalk(
  absDir: string,
  root: string,
  out: Record<string, string | { data: string; encoding: 'base64' }>,
): void {
  let entries: ReturnType<typeof readdirSync>
  try {
    entries = readdirSync(absDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const abs = join(absDir, entry.name)
    const rel = relative(root, abs)
    if (isExcludedRelPath(rel)) continue
    if (entry.isDirectory()) {
      snapshotWalk(abs, root, out)
      continue
    }
    if (!entry.isFile()) continue
    try {
      const stats = statSync(abs)
      // 5MB ceiling per file: snapshots persist into a JSON column, so a
      // rogue 200MB binary would hit Postgres TOAST limits and explode
      // every read. Real templates are well under this.
      if (stats.size > 5 * 1024 * 1024) continue
      const buf = readFileSync(abs)
      const key = rel.split('\\').join('/')
      if (looksBinary(buf)) {
        out[key] = { data: buf.toString('base64'), encoding: 'base64' }
      } else {
        out[key] = buf.toString('utf8')
      }
    } catch {
      // Unreadable files are silently skipped.
    }
  }
}

function looksBinary(buf: Buffer): boolean {
  // Sniff the first 4KB for a NUL byte. Reliable for source-tree heuristics
  // (text formats never contain NUL); avoids the expense of parsing UTF-8.
  const probe = buf.subarray(0, Math.min(buf.length, 4096))
  return probe.includes(0)
}
