// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Streaming writer for a workspace archive.
 *
 * The project exporter builds its bundle in memory (`zipSync` over a fully
 * buffered file map). That is fine for one project and fatal for a workspace:
 * a whole workspace is "every project tree + every attachment", which would
 * OOM an API pod long before the archive is ready. So this writer compresses
 * each entry as it is added and streams the result to a temp file.
 *
 * Entry metadata (bytes + sha256 of the *uncompressed* content) is collected
 * as we go, so `manifest.json` can be appended last and still describe every
 * earlier entry.
 */

import { createHash } from 'node:crypto'
import { closeSync, openSync, writeSync } from 'node:fs'
import { AsyncZipDeflate, Zip } from 'fflate'

export interface ArchiveEntryMeta {
  path: string
  bytes: number
  sha256: string
}

export interface ArchiveLimits {
  /** Uncompressed bytes across every entry. */
  maxTotalBytes: number
  /** Entry count (files + JSON rows). */
  maxFiles: number
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxTotalBytes: 500 * 1024 * 1024,
  maxFiles: 20_000,
}

export class WorkspaceExportTooLargeError extends Error {
  readonly code = 'workspace_export_too_large'
  constructor(
    message: string,
    readonly limit: 'bytes' | 'files',
    readonly observed: number,
    readonly cap: number,
    readonly contributors: Array<{ path: string; bytes: number }> = [],
  ) {
    super(message)
    this.name = 'WorkspaceExportTooLargeError'
  }
}

export class ArchiveWriter {
  private zip: Zip
  private readonly fd: number
  private closed = false
  private readonly entries: ArchiveEntryMeta[] = []
  private totalBytes = 0
  private readonly sizes: Array<{ path: string; bytes: number }> = []
  private finished: Promise<number> | null = null
  private resolveFinished: ((bytes: number) => void) | null = null
  private rejectFinished: ((err: unknown) => void) | null = null
  private bytesWritten = 0
  private streamError: unknown = null

  constructor(
    readonly tempPath: string,
    private readonly limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
  ) {
    this.fd = openSync(tempPath, 'w')
    this.zip = new Zip((err, chunk, final) => {
      if (err) {
        this.streamError = err
        this.rejectFinished?.(err)
        return
      }
      try {
        if (chunk && chunk.byteLength) {
          writeSync(this.fd, chunk)
          this.bytesWritten += chunk.byteLength
        }
        if (final) this.resolveFinished?.(this.bytesWritten)
      } catch (writeErr) {
        this.streamError = writeErr
        this.rejectFinished?.(writeErr)
      }
    })
  }

  get entryCount(): number {
    return this.entries.length
  }

  get uncompressedBytes(): number {
    return this.totalBytes
  }

  get compressedBytes(): number {
    return this.bytesWritten
  }

  /** Entry metadata collected so far (for a manifest that lists earlier entries). */
  entriesForManifest(): ArchiveEntryMeta[] {
    return this.entries.map((entry) => ({ ...entry }))
  }

  private guard(path: string, size: number): void {
    if (this.entries.length + 1 > this.limits.maxFiles) {
      throw new WorkspaceExportTooLargeError(
        `The workspace has more than ${this.limits.maxFiles.toLocaleString()} files.`,
        'files',
        this.entries.length + 1,
        this.limits.maxFiles,
      )
    }
    if (this.totalBytes + size > this.limits.maxTotalBytes) {
      const contributors = [...this.sizes]
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 5)
        .map((entry) => ({ path: entry.path, bytes: entry.bytes }))
      throw new WorkspaceExportTooLargeError(
        `The workspace is larger than the ${Math.round(this.limits.maxTotalBytes / (1024 * 1024))} MB export limit.`,
        'bytes',
        this.totalBytes + size,
        this.limits.maxTotalBytes,
        contributors,
      )
    }
  }

  async addBytes(path: string, data: Uint8Array): Promise<void> {
    if (this.finished) throw new Error('ArchiveWriter: cannot add after finish()')
    // `AsyncZipDeflate` transfers the buffer to its worker, which detaches it:
    // read the size and hash *before* the push or both come back empty.
    const byteLength = data.byteLength
    const digest = createHash('sha256').update(data).digest('hex')
    this.guard(path, byteLength)
    const file = new AsyncZipDeflate(path, { level: 6 })
    const entryDone = new Promise<void>((resolvePush, rejectPush) => {
      let settled = false
      const done = () => {
        if (!settled) {
          settled = true
          resolvePush()
        }
      }
      const fail = (err: unknown) => {
        if (!settled) {
          settled = true
          rejectPush(err)
        }
      }
      // `Zip.add` installs its own `ondata` (it writes the local header, the
      // compressed chunks and the data descriptor). Wrap it rather than
      // replace it, so the archive stays valid and we still learn when this
      // entry is fully deflated — that is what keeps entries ordered and the
      // in-flight window at one file.
      this.zip.add(file)
      const inner = file.ondata
      file.ondata = (err, chunk, final) => {
        inner(err, chunk, final)
        if (err) fail(err)
        else if (final) done()
      }
      try {
        // Push a copy: the async deflate transfers (and thus detaches) the
        // buffer it is given, and callers must not lose their own bytes.
        file.push(data.slice(), true)
      } catch (err) {
        fail(err)
      }
    })
    await entryDone
    this.entries.push({ path, bytes: byteLength, sha256: digest })
    this.totalBytes += byteLength
    this.sizes.push({ path, bytes: byteLength })
  }

  async addJson(path: string, value: unknown): Promise<void> {
    const text = JSON.stringify(value)
    await this.addBytes(path, new TextEncoder().encode(text))
  }

  /** Finalise the archive and resolve with the compressed byte count. */
  async finish(): Promise<{ bytes: number; entries: ArchiveEntryMeta[] }> {
    if (this.finished) {
      const bytes = await this.finished
      return { bytes, entries: this.entries }
    }
    this.finished = new Promise<number>((resolveFinish, rejectFinish) => {
      this.resolveFinished = resolveFinish
      this.rejectFinished = rejectFinish
    })
    try {
      this.zip.end()
      const bytes = await this.finished
      this.cleanup()
      if (this.streamError) throw this.streamError
      return { bytes, entries: this.entries }
    } catch (err) {
      this.cleanup()
      throw err
    }
  }

  /** Abandon the archive and remove the partial file. */
  abort(): void {
    this.cleanup()
  }

  private cleanup(): void {
    if (this.closed) return
    this.closed = true
    try {
      closeSync(this.fd)
    } catch {
      /* already closed */
    }
    try {
      this.zip.terminate()
    } catch {
      /* already ended */
    }
  }
}
