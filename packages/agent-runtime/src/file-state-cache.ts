// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * File State Cache — tracks which files the agent has read and their
 * modification times. Used to:
 * 1. Include a "files already seen" summary in compaction so the model
 *    retains awareness of files it read before context was trimmed.
 * 2. Detect stale reads (file changed on disk since last read).
 * 3. Provide context for sub-agents via cloning.
 */

import { statSync } from 'fs'
import { posix } from 'path'

export interface FileReadRecord {
  path: string
  mtime: number
  lineCount: number
  readAt: number
  partial?: { offset: number; limit: number }
  /** Full file content at read time — used for staleness content-comparison fallback */
  content?: string
}

export class FileStateCache {
  private reads = new Map<string, FileReadRecord>()
  private editedThisTurn = new Set<string>()
  private workspaceDir?: string

  constructor(workspaceDir?: string) {
    if (workspaceDir) this.setWorkspaceDir(workspaceDir)
  }

  /**
   * Set the workspace root so absolute paths under it collapse to the same
   * canonical key as their relative spelling. Safe to call after construction
   * (the gateway constructs the cache as a field initializer, before it knows
   * the workspace dir).
   */
  setWorkspaceDir(dir: string): void {
    this.workspaceDir = dir.replace(/\\/g, '/').replace(/\/+$/, '')
  }

  /**
   * Canonicalize a path so different spellings of the SAME file map to one
   * cache key. This is the fix for the #1 production tool error
   * ("File has not been read yet"): the agent would read `src/foo.ts` and
   * then edit `./src/foo.ts` (or a backslash / absolute variant) and the
   * read-before-edit guard, keyed on the raw string, wouldn't find the read.
   * We strip a leading workspace prefix, normalize separators, and collapse
   * `./` / `../` / duplicate slashes via posix.normalize.
   */
  private normalizeKey(path: string): string {
    let s = path.replace(/\\/g, '/')
    if (this.workspaceDir && (s === this.workspaceDir || s.startsWith(this.workspaceDir + '/'))) {
      s = s.slice(this.workspaceDir.length + 1)
    }
    s = posix.normalize(s)
    if (s.startsWith('./')) s = s.slice(2)
    return s
  }

  /**
   * Mark a file as edited/written during the current agent turn.
   * Read by the read_lints tool to auto-scope diagnostics when no
   * explicit path is provided. Cleared via resetTurn() at the start
   * of each top-level runAgentLoop call.
   */
  markEditedThisTurn(path: string): void {
    this.editedThisTurn.add(this.normalizeKey(path))
  }

  /** Return the list of files edited in the current turn. */
  getEditedThisTurn(): string[] {
    return [...this.editedThisTurn]
  }

  /** Clear the per-turn edit set. Called at the start of each top-level turn. */
  resetTurn(): void {
    this.editedThisTurn.clear()
  }

  recordRead(
    path: string,
    mtime: number,
    lineCount: number,
    partial?: { offset: number; limit: number },
    content?: string,
  ): void {
    const key = this.normalizeKey(path)
    const existing = this.reads.get(key)
    if (existing && !partial && existing.partial) {
      // Full read supersedes a previous partial read
    }
    this.reads.set(key, {
      path: key, mtime: Math.floor(mtime), lineCount, readAt: Date.now(), partial,
      content: partial ? undefined : content,
    })
  }

  /**
   * Record post-edit state so subsequent staleness checks work
   * within the same turn (instead of just invalidating).
   */
  recordEdit(path: string, content: string, mtime: number): void {
    const key = this.normalizeKey(path)
    const lineCount = content.split('\n').length
    this.reads.set(key, { path: key, mtime: Math.floor(mtime), lineCount, readAt: Date.now(), content })
  }

  hasBeenRead(path: string): boolean {
    return this.reads.has(this.normalizeKey(path))
  }

  getRecord(path: string): FileReadRecord | undefined {
    return this.reads.get(this.normalizeKey(path))
  }

  /**
   * Check if a file has been modified on disk since the agent last read it.
   * Returns true if the mtime differs. Returns false if the file can't be
   * stat'd (deleted) or hasn't been read.
   */
  isStale(path: string, resolvedPath: string): boolean {
    const record = this.reads.get(this.normalizeKey(path))
    if (!record) return false
    try {
      const currentMtime = Math.floor(statSync(resolvedPath).mtimeMs)
      return currentMtime !== record.mtime
    } catch {
      return true
    }
  }

  /** Invalidate a cached entry (call after writes/edits/deletes). */
  invalidate(path: string): void {
    this.reads.delete(this.normalizeKey(path))
  }

  /** Number of tracked files. */
  get size(): number {
    return this.reads.size
  }

  /**
   * Build a human-readable summary for injection into compaction context.
   * Keeps the summary concise — only file name, line count, and staleness.
   */
  getSummary(workspaceDir: string): string {
    if (this.reads.size === 0) return ''

    const lines: string[] = ['## Files Previously Read']
    const entries = [...this.reads.values()]
      .sort((a, b) => b.readAt - a.readAt)
      .slice(0, 50)

    for (const entry of entries) {
      const staleTag = this.isStale(entry.path, `${workspaceDir}/${entry.path}`)
        ? ' (modified since read)'
        : ''
      const partialTag = entry.partial
        ? ` [lines ${entry.partial.offset}-${entry.partial.offset + entry.partial.limit}]`
        : ''
      lines.push(`- \`${entry.path}\` (${entry.lineCount} lines${partialTag}${staleTag})`)
    }

    if (this.reads.size > 50) {
      lines.push(`- ... and ${this.reads.size - 50} more files`)
    }

    return lines.join('\n')
  }

  /**
   * Create an independent copy (for sub-agents).
   * Intentionally does NOT copy editedThisTurn — each sub-agent's turn
   * starts with its own empty edit set.
   */
  clone(): FileStateCache {
    const copy = new FileStateCache(this.workspaceDir)
    for (const [key, value] of this.reads) {
      copy.reads.set(key, { ...value })
    }
    return copy
  }

  clear(): void {
    this.reads.clear()
    this.editedThisTurn.clear()
  }
}
