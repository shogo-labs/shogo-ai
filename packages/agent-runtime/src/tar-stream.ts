// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Extract a gzipped tar directly from a request body, without ever writing the
 * archive down.
 *
 * Hydrating a project used to cost the archive twice: once to hold it (RAM, and
 * then a tmpfs spool that was RAM wearing a filesystem's clothes) and once for
 * what came out of it. A 4 GiB guest with ~3.8 GiB free on its rootfs cannot
 * pay that for the multi-gigabyte projects this exists to restore. Piping the
 * body straight into `tar` makes the peak the extracted tree alone.
 */

import { closeSync, openSync, unlinkSync } from 'node:fs'
import { spoolPath } from './spool'

/** GNU tar cannot sniff compression on a pipe: `-z` is required, not optional. */
const TAR_ARGS = ['-xzv', '--no-same-owner', '--no-same-permissions']

/** How much of tar's diagnostics to keep for an error message. */
const STDERR_TAIL_BYTES = 8192

export interface TarStreamResult {
  /** Bytes read from the body — the compressed size. */
  bytes: number
  /** Extracted paths matching the caller's filter, in archive order. */
  matched: string[]
}

export interface ScanResult {
  matched: string[]
  /** Trailing output, capped, for diagnostics. */
  tail: string
}

/**
 * Read `body` into `tar`, extracting into `cwd`.
 *
 * `keep` selects which extracted paths are returned. It exists so callers don't
 * accumulate the full listing: `-v` names every file, and a large project has
 * hundreds of thousands of them, which would reintroduce a size-proportional
 * allocation on the exact path that is trying to avoid one.
 *
 * Throws on a non-zero tar exit, with tar's own diagnostics attached. Callers
 * treat hydrate as fail-closed, so a partially extracted workspace is safe: the
 * host destroys the VM rather than serving it.
 */
export async function extractTarStream(
  body: ReadableStream<Uint8Array>,
  cwd: string,
  keep: RegExp,
  spawn: typeof Bun.spawn = Bun.spawn,
): Promise<TarStreamResult> {
  // tar's output goes to a FILE rather than a pipe, for two independent
  // reasons that happen to have the same fix:
  //
  //  - Deadlock. `tar -v` prints a line per extracted file. A pipe holds ~64 KB,
  //    so on a real project tar blocks writing its listing, stops reading the
  //    archive, and we block feeding it.
  //  - Truncation. Draining that pipe concurrently avoids the deadlock, but
  //    when stdin is hand-pumped Bun delivers only the FIRST chunk of the
  //    child's output and then closes the stream — while the exit status still
  //    says success. Downstream that reads as "the archive held one file",
  //    which for the SQLite check means a restored database quietly left beside
  //    a stale WAL. A silent wrong answer, not an error.
  //
  // The file is proportional to the FILE COUNT, not to the archive size: a
  // 200k-file project writes a few MB, against an archive of gigabytes.
  const listingPath = spoolPath('tar-listing.txt')
  const fd = openSync(listingPath, 'w')
  let fdOpen = true

  try {
    // stdin stays hand-pumped. Handing Bun the ReadableStream instead makes it
    // accumulate: measured at +2.4 GB of RSS for a 1 GB archive, which is the
    // exact failure being engineered out here. write()+flush() holds one chunk.
    const proc = spawn(['tar', ...TAR_ARGS, '-C', cwd], { stdin: 'pipe', stdout: fd, stderr: fd })

    let bytes = 0
    try {
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        bytes += chunk.byteLength
        proc.stdin.write(chunk)
        // Bound the writer's buffer. Without this the pipe is just a slower way
        // of holding the whole archive in memory.
        await proc.stdin.flush()
      }
    } finally {
      proc.stdin.end()
    }

    const code = await proc.exited
    closeSync(fd)
    fdOpen = false

    // Read back with the same line scanner, so a huge listing still costs one
    // buffer rather than its full size.
    const { matched, tail } = await scanTarOutput(
      Bun.file(listingPath).stream() as unknown as ReadableStream<Uint8Array>,
      keep,
      STDERR_TAIL_BYTES,
    )
    if (code !== 0) {
      throw new Error(`tar exited ${code}: ${tail.trim().slice(-400) || 'no output'}`)
    }
    return { bytes, matched }
  } finally {
    if (fdOpen) {
      try {
        closeSync(fd)
      } catch {}
    }
    try {
      unlinkSync(listingPath)
    } catch {}
  }
}

/**
 * Scan a tar output stream line by line, keeping only what the caller asked
 * for plus (optionally) a bounded tail for error reporting.
 *
 * Deliberately never accumulates the stream: on a large project the listing is
 * tens of megabytes, and buffering it would put back the allocation this whole
 * path exists to avoid.
 */
export async function scanTarOutput(
  stream: ReadableStream<Uint8Array>,
  keep: RegExp,
  tailBytes = 0,
): Promise<ScanResult> {
  const matched: string[] = []
  const decoder = new TextDecoder()
  let buf = ''
  let tail = ''

  const take = (raw: string) => {
    const line = normalizeListingLine(raw)
    if (line && keep.test(line)) matched.push(line)
  }

  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    const text = decoder.decode(chunk, { stream: true })
    if (tailBytes > 0) tail = (tail + text).slice(-tailBytes)
    buf += text
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      take(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
    }
  }
  take(buf)
  return { matched, tail }
}

/**
 * Normalize one line of tar verbose output to a bare path.
 *
 * bsdtar prefixes each extracted entry with `x `; GNU tar prints the path
 * alone. Without this the same archive yields paths that compare equal on Linux
 * and not on macOS, which downstream turns into a database restored next to a
 * stale WAL.
 */
function normalizeListingLine(raw: string): string {
  const line = raw.trim()
  return line.startsWith('x ') ? line.slice(2).trim() : line
}
