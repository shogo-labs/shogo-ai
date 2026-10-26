// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Memory write history + shrink guard.
 *
 * Why this exists
 * ---------------
 * An agent's memory files (`MEMORY.md`, `AGENTS.md`, `TOOLS.md`,
 * `HEARTBEAT.md`, `STACK.md`, `memory/*.md`) are ordinary workspace files
 * written through the generic `write_file` / `edit_file` tools, so a single
 * whole-file write — `write_file({ path: 'MEMORY.md', content: '- Agent
 * booted at …' })` — erases everything the agent had learned. That happened
 * on 2026-10-19 (Dev 3) and the lessons block had to be rebuilt by hand.
 *
 * Two mechanisms, no new agent-facing tools (Russell's constraint):
 *
 * 1. `snapshotMemoryFile()` copies the file's current bytes to
 *    `<workspace>/.shogo/memory-history/<sanitized-path>/<ISO>-<n>.md`
 *    *before* every write, keeping the newest {@link MEMORY_HISTORY_KEEP} per
 *    file. Recovery is a plain `read_file` on that folder, and `.shogo/
 *    memory-history/**` is un-ignored in the project's `.gitignore` so the
 *    copies ride along in checkpoints.
 * 2. `memoryShrinkGuard()` refuses a `write_file` that would replace a memory
 *    file with less than half of its current content, unless the caller
 *    passes `overwrite: true`. `edit_file` is exempt — it is already a diff.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

/** Workspace-relative folder that holds the memory write history. */
export const MEMORY_HISTORY_DIR = '.shogo/memory-history'

/** How many history copies to keep per memory file. */
export const MEMORY_HISTORY_KEEP = 20

/**
 * A write that would leave a memory file below this fraction of its current
 * size is treated as an accidental wipe. 0.5 => 49 % is refused, 51 % writes.
 */
export const MEMORY_SHRINK_MIN_RATIO = 0.5

/** Files that hold durable agent state (workspace root, by basename). */
const MEMORY_ROOT_FILES = new Set([
  'MEMORY.md',
  'AGENTS.md',
  'TOOLS.md',
  'HEARTBEAT.md',
  'STACK.md',
])

/** Normalize a tool-supplied path into a workspace-relative POSIX path. */
function normalizeRelative(relativePath: string): string {
  return relativePath
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/')
}

/**
 * Classify a path as a memory file, returning its normalized relative path,
 * or null when it is ordinary project content. Exactly two shapes qualify:
 * one of the root memory files, or `<something>.md` directly inside `memory/`.
 */
export function memoryFilePath(relativePath: string): string | null {
  if (!relativePath) return null
  const normalized = normalizeRelative(relativePath)
  if (!normalized || normalized.includes('..')) return null
  const segments = normalized.split('/')
  if (segments.length === 1) {
    return MEMORY_ROOT_FILES.has(segments[0]!) ? normalized : null
  }
  if (segments.length === 2 && segments[0] === 'memory' && segments[1]!.endsWith('.md')) {
    return normalized
  }
  return null
}

/** True when the write targets durable agent state. */
export function isMemoryFilePath(relativePath: string): boolean {
  return memoryFilePath(relativePath) !== null
}

/** `memory/2026-10-19.md` -> `memory__2026-10-19.md` (a directory name). */
export function sanitizeMemoryPath(relativePath: string): string {
  return normalizeRelative(relativePath).replace(/[^A-Za-z0-9._-]+/g, '__')
}

/** Where the history copies for one memory file live (workspace-relative). */
export function memoryHistoryDirFor(relativePath: string): string {
  return `${MEMORY_HISTORY_DIR}/${sanitizeMemoryPath(relativePath)}`
}

function existingHistoryCopyNames(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .sort()
  } catch {
    return []
  }
}

/**
 * Copy the current content of a memory file into its history folder before it
 * is overwritten. Returns the workspace-relative path of the copy, or null
 * when the path is not a memory file or there is nothing to preserve.
 *
 * Never throws: a failed history copy must not fail the write it protects.
 */
export function snapshotMemoryFile(workspaceDir: string, relativePath: string): string | null {
  try {
    const memoryPath = memoryFilePath(relativePath)
    if (!memoryPath) return null

    const absolute = join(workspaceDir, memoryPath)
    if (!existsSync(absolute)) return null
    const current = readFileSync(absolute, 'utf-8')
    if (current.length === 0) return null

    const historyRelative = memoryHistoryDirFor(memoryPath)
    const historyDir = join(workspaceDir, historyRelative)
    mkdirSync(historyDir, { recursive: true })

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const prefix = `${stamp}.`
    const existing = existingHistoryCopyNames(historyDir).filter((name) => name.startsWith(prefix))
    const lastCounter = existing.reduce((max, name) => {
      const n = Number.parseInt(name.slice(prefix.length), 10)
      return Number.isFinite(n) && n > max ? n : max
    }, 0)
    // Zero-padded so copies made in the same millisecond still sort by write
    // order — prune keeps "the newest N" by name alone.
    const copyName = `${prefix}${String(lastCounter + 1).padStart(4, '0')}.md`
    writeFileSync(join(historyDir, copyName), current, 'utf-8')

    pruneMemoryHistory(historyDir)
    return `${historyRelative}/${copyName}`
  } catch {
    return null
  }
}

/** Keep only the newest {@link MEMORY_HISTORY_KEEP} copies (names sort by time). */
function pruneMemoryHistory(historyDir: string): void {
  const names = existingHistoryCopyNames(historyDir)
  if (names.length <= MEMORY_HISTORY_KEEP) return
  for (const name of names.slice(0, names.length - MEMORY_HISTORY_KEEP)) {
    try {
      unlinkSync(join(historyDir, name))
    } catch {
      /* a copy we can't delete is not worth failing a write over */
    }
  }
}

export interface MemoryShrinkRejection {
  code: 'memory_shrink_guard'
  error: string
  path: string
  currentChars: number
  newChars: number
  ratio: number
  historyDir: string
}

/**
 * Refuse a whole-file write that would wipe a memory file.
 *
 * Returns null when the write is allowed: not a memory file, file does not
 * exist yet (a create), an append (cannot shrink), `overwrite: true`, or a
 * shrink smaller than {@link MEMORY_SHRINK_MIN_RATIO}.
 */
export function memoryShrinkGuard(
  workspaceDir: string,
  relativePath: string,
  newContent: string,
  options?: { overwrite?: boolean; append?: boolean },
): MemoryShrinkRejection | null {
  if (options?.overwrite || options?.append) return null

  const memoryPath = memoryFilePath(relativePath)
  if (!memoryPath) return null

  const absolute = join(workspaceDir, memoryPath)
  let currentLength: number
  try {
    if (!existsSync(absolute)) return null
    if (!statSync(absolute).isFile()) return null
    currentLength = readFileSync(absolute, 'utf-8').length
  } catch {
    return null
  }
  if (currentLength === 0) return null

  const newLength = newContent.length
  const ratio = newLength / currentLength
  if (ratio >= MEMORY_SHRINK_MIN_RATIO) return null

  const historyDir = memoryHistoryDirFor(memoryPath)
  return {
    code: 'memory_shrink_guard',
    error:
      `write_file would replace ${memoryPath} (${currentLength} chars) with ${newLength} chars ` +
      `(${Math.round(ratio * 100)}% of its current size). Refusing what looks like an accidental wipe. ` +
      `Two ways forward: (1) keep the existing content and add to it — call write_file with ` +
      `append: true, or read_file then edit_file with the exact text to change; ` +
      `(2) if the replacement is deliberate, call write_file again with overwrite: true. ` +
      `A copy of the current file is kept under ${historyDir}/ before any write lands.`,
    path: memoryPath,
    currentChars: currentLength,
    newChars: newLength,
    ratio,
    historyDir,
  }
}

/** Exported for tests: the history folder's absolute path for a memory file. */
export function memoryHistoryDirAbsolute(workspaceDir: string, relativePath: string): string {
  return join(workspaceDir, memoryHistoryDirFor(relativePath))
}

/** Exported for tests: parent directory of a memory file (module-private helper parity). */
export function memoryFileDirectory(workspaceDir: string, relativePath: string): string {
  return dirname(join(workspaceDir, normalizeRelative(relativePath)))
}
