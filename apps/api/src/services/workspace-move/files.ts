// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Project files, moved without an archive.
 *
 * The archive path builds one zip in memory/temp and refuses anything over
 * 500 MB. A move cannot: a content workspace is 19 GB, the connection drops,
 * and the user closes the laptop. So files travel one at a time against a
 * manifest of `path + bytes + sha256`:
 *
 *   - the source hashes each file once (`walkMoveFiles`);
 *   - the target reports what it already holds (same path, same hash);
 *   - only the difference is sent, so a resume after a dropped connection
 *     resends nothing that landed.
 *
 * Ignore rules are applied on the source, where the file tree is, and the
 * numbers they saved travel in the plan step so "19.5 GB" is explained rather
 * than silently smaller.
 */

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { isExcludedRelPath } from '../workspace-export/files'
import { isMoveIgnored, moveIgnoreRules, type IgnoreRule } from './ignores'
import { WORKSPACE_ROOT_ID, type MoveFileEntry } from './types'

/** Sizes only, for a subtree the ignore rules excluded. */
function sumTree(dir: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  const visit = (current: string) => {
    let items
    try {
      items = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      const full = join(current, item.name)
      if (item.isDirectory()) {
        visit(full)
        continue
      }
      if (!item.isFile() && !item.isSymbolicLink()) continue
      try {
        const stat = statSync(full)
        if (stat.isFile()) {
          files++
          bytes += stat.size
        }
      } catch {
        // Unreadable entries are not counted; the move reports them as skipped.
      }
    }
  }
  visit(dir)
  return { files, bytes }
}

export interface WalkResult {
  entries: MoveFileEntry[]
  ignored: { files: number; bytes: number }
  /** Files the walk could not read; reported, never fatal. */
  errors: Array<{ path: string; reason: string }>
}

export interface WalkOptions {
  rules?: readonly IgnoreRule[]
  /** Hash every file. Off for the plan step, where sizes are enough. */
  hash?: boolean
  maxFiles?: number
}

function hashFile(path: string): Promise<string> {
  return new Promise((done, fail) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', fail)
    stream.on('end', () => done(hash.digest('hex')))
  })
}

/**
 * Walk a project directory into a manifest.
 *
 * Symlinks are followed only when their real path stays inside `rootDir` — the
 * same rule the archive uses, so a move can never carry another project's files
 * (or `/etc`) by way of a link.
 */
export async function walkMoveFiles(rootDir: string, opts: WalkOptions = {}): Promise<WalkResult> {
  const rules = opts.rules ?? moveIgnoreRules(rootDir)
  const hash = opts.hash !== false
  const maxFiles = opts.maxFiles ?? 200_000
  const entries: MoveFileEntry[] = []
  const errors: Array<{ path: string; reason: string }> = []
  const ignored = { files: 0, bytes: 0 }
  if (!existsSync(rootDir)) return { entries, ignored, errors }

  const rootReal = realpathSync(rootDir)
  // A negated rule can bring back a file under an ignored directory, so the
  // walk only prunes an ignored subtree when nothing could re-include it.
  const canReInclude = rules.some((rule) => rule.negated)

  const walk = async (dir: string): Promise<void> => {
    let items
    try {
      items = readdirSync(dir, { withFileTypes: true })
    } catch (err: any) {
      errors.push({ path: relative(rootDir, dir), reason: `readdir:${err?.message ?? 'unknown'}` })
      return
    }
    for (const item of items) {
      const full = join(dir, item.name)
      const relPath = relative(rootDir, full).replace(/\\/g, '/')
      if (relPath.includes('..')) continue

      let isDir = item.isDirectory()
      let isFile = item.isFile()
      if (item.isSymbolicLink()) {
        let target: string
        try {
          target = realpathSync(full)
        } catch {
          ignored.files++
          continue
        }
        if (target !== rootReal && !target.startsWith(rootReal + '/')) {
          errors.push({ path: relPath, reason: 'symlink-outside-root' })
          continue
        }
        const stat = statSync(full)
        isDir = stat.isDirectory()
        isFile = stat.isFile()
      }

      if (isDir) {
        if (isMoveIgnored(relPath, true, rules) && !canReInclude) {
          // The subtree is not travelling, but the plan step still reports what
          // it saved — otherwise `out/` would look free.
          const saved = sumTree(full)
          ignored.files += saved.files
          ignored.bytes += saved.bytes
          continue
        }
        await walk(full)
        continue
      }
      if (!isFile) continue
      if (isMoveIgnored(relPath, false, rules) || isExcludedRelPath(relPath)) {
        try {
          const stat = statSync(full)
          ignored.files++
          ignored.bytes += stat.size
        } catch {
          ignored.files++
        }
        continue
      }
      if (entries.length >= maxFiles) {
        errors.push({ path: relPath, reason: `more-than-${maxFiles}-files` })
        continue
      }
      try {
        const stat = statSync(full)
        entries.push({
          path: relPath,
          bytes: stat.size,
          sha256: hash ? await hashFile(full) : '',
        })
      } catch (err: any) {
        errors.push({ path: relPath, reason: `stat:${err?.message ?? 'unknown'}` })
      }
    }
  }

  await walk(rootDir)
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { entries, ignored, errors }
}

export interface FileDiff {
  toSend: MoveFileEntry[]
  skipped: number
  skippedBytes: number
}

/**
 * What still has to cross. A file counts as already there when the target has
 * the same path *and* the same hash — size alone would let a half-written file
 * from an interrupted upload pass as done.
 */
export function diffFileManifest(source: readonly MoveFileEntry[], target: readonly MoveFileEntry[]): FileDiff {
  const known = new Map<string, string>()
  for (const entry of target) known.set(entry.path, entry.sha256)
  const toSend: MoveFileEntry[] = []
  let skipped = 0
  let skippedBytes = 0
  for (const entry of source) {
    const existing = known.get(entry.path)
    if (existing && existing === entry.sha256) {
      skipped++
      skippedBytes += entry.bytes
      continue
    }
    toSend.push(entry)
  }
  return { toSend, skipped, skippedBytes }
}

/**
 * Unsafe paths are refused rather than sanitised: a move receives its paths from
 * the other side of a network link, and silently "fixing" one would hide a bug
 * (or an attack) instead of reporting it.
 */
export function assertSafeRelPath(relPath: string): string {
  const normalised = relPath.replace(/\\/g, '/')
  if (
    !normalised ||
    normalised.startsWith('/') ||
    /^[a-zA-Z]:\//.test(normalised) ||
    normalised.split('/').includes('..') ||
    normalised.includes('\0')
  ) {
    throw new Error(`unsafe path: ${relPath.slice(0, 120)}`)
  }
  return normalised
}

/** Write one received file under `rootDir`, creating parents as needed. */
export function writeMoveFile(rootDir: string, relPath: string, bytes: Uint8Array): string {
  const safe = assertSafeRelPath(relPath)
  const target = resolve(rootDir, safe)
  const root = resolve(rootDir)
  if (target !== root && !target.startsWith(root + '/')) {
    throw new Error(`path escapes the project root: ${relPath.slice(0, 120)}`)
  }
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, bytes)
  return target
}

/**
 * The directory a move's `projectId` refers to.
 *
 * The runner sends one sentinel, `WORKSPACE_ROOT_ID`, for the workspace's own
 * root (its `CLAUDE.md`, `.shogo/`, anything not inside a project). That root
 * lives at `<base>/.workspace-roots/<workspaceId>` — *not* at `<base>/<id>` like
 * a project directory — so the sentinel has to be translated, and translated in
 * one place. Only the HTTP receive routes did it; the in-process
 * `LocalMoveSource`/`LocalMoveTarget` a desktop uses passed the sentinel
 * straight into `join(base, projectId)`, which made the source manifest for the
 * root come back empty and wrote cloud -> desktop root files into a stray
 * `<base>/__workspace_root__` directory.
 *
 * The two sides therefore differ only in `base` (and, on the source, in
 * `ProjectFolder` redirection for folder-linked projects, which happens before
 * this is called).
 */
export function moveDirFor(input: { projectId: string; workspaceId: string; base: string }): string {
  if (input.projectId === WORKSPACE_ROOT_ID) {
    return join(input.base, '.workspace-roots', input.workspaceId)
  }
  // A root addressed directly (`receive/files/*` accepts this form so a caller
  // can target one workspace's root without knowing the sentinel).
  if (input.projectId.startsWith('.workspace-roots/')) return join(input.base, input.projectId)
  return join(input.base, input.projectId)
}

export function fileExists(path: string): boolean {
  try {
    return lstatSync(path).isFile()
  } catch {
    return false
  }
}
