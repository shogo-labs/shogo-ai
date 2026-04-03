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

  recordRead(
    path: string,
    mtime: number,
    lineCount: number,
    partial?: { offset: number; limit: number },
    content?: string,
  ): void {
    const existing = this.reads.get(path)
    if (existing && !partial && existing.partial) {
      // Full read supersedes a previous partial read
    }
    this.reads.set(path, {
      path, mtime: Math.floor(mtime), lineCount, readAt: Date.now(), partial,
      content: partial ? undefined : content,
    })
  }

  /**
   * Record post-edit state so subsequent staleness checks work
   * within the same turn (instead of just invalidating).
   */
  recordEdit(path: string, content: string, mtime: number): void {
    const lineCount = content.split('\n').length
    this.reads.set(path, { path, mtime: Math.floor(mtime), lineCount, readAt: Date.now(), content })
  }

  hasBeenRead(path: string): boolean {
    return this.reads.has(path)
  }

  getRecord(path: string): FileReadRecord | undefined {
    return this.reads.get(path)
  }

  /**
   * Check if a file has been modified on disk since the agent last read it.
   * Returns true if the mtime differs. Returns false if the file can't be
   * stat'd (deleted) or hasn't been read.
   */
  isStale(path: string, resolvedPath: string): boolean {
    const record = this.reads.get(path)
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
    this.reads.delete(path)
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

  /** Create an independent copy (for sub-agents). */
  clone(): FileStateCache {
    const copy = new FileStateCache()
    for (const [key, value] of this.reads) {
      copy.reads.set(key, { ...value })
    }
    return copy
  }

  clear(): void {
    this.reads.clear()
  }
}
