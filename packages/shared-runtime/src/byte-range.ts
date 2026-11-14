// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Byte-range serving for files that are read off a disk.
 *
 * Media elements are the reason this exists: iOS AVPlayer and Safari issue a
 * `Range` request before they will play a remote clip at all, and every player
 * seeks with one. A route that answers 200 with the whole body makes a 300 MB
 * mp4 download in full before the first frame. Every route that hands out a
 * stored or on-disk file should answer with `fileRangeResponse` instead, so
 * the same behaviour holds on the runtime, the desktop API and the cloud API.
 */

export type ParsedByteRange =
  | { kind: 'range'; start: number; end: number }
  | { kind: 'unsatisfiable' }
  | { kind: 'none' }

/**
 * A single `bytes=` range, resolved against the file size.
 *
 * An unsupported or malformed range is reported as `none` so the caller serves
 * the whole file, which is what RFC 9110 asks for; only a syntactically valid
 * range that starts past the end is `unsatisfiable`.
 */
export function parseByteRange(header: string | undefined | null, size: number): ParsedByteRange {
  if (!header) return { kind: 'none' }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return { kind: 'none' }
  const [, rawStart, rawEnd] = match
  if (!rawStart && !rawEnd) return { kind: 'none' }
  if (size <= 0) return { kind: 'unsatisfiable' }

  if (!rawStart) {
    // `bytes=-N`: the final N bytes.
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return { kind: 'none' }
    return { kind: 'range', start: Math.max(0, size - suffix), end: size - 1 }
  }

  const start = Number(rawStart)
  if (!Number.isFinite(start) || start >= size) return { kind: 'unsatisfiable' }
  const end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1
  if (!Number.isFinite(end) || end < start) return { kind: 'none' }
  return { kind: 'range', start, end }
}

/**
 * The bytes of a file from `start` to `end` (inclusive), without reading the
 * rest. `Bun.file(path)` satisfies this and streams lazily.
 */
export interface SliceableFile {
  slice(start: number, end: number): BodyInit
}

export interface FileRangeResponseOptions {
  /** The file, as a lazily-sliceable blob. */
  file: SliceableFile
  size: number
  rangeHeader?: string | null
  /** Content-Type, Content-Disposition and anything else the route adds. */
  headers?: Record<string, string>
  /** Overrides the status of the whole-file answer (default 200). */
  status?: number
}

/**
 * A `Response` for `file`: `206` with `Content-Range` for a satisfiable range,
 * `416` with `bytes *\/size` for a range past the end, otherwise the whole
 * file. `Accept-Ranges: bytes` is always sent so a player knows it may seek.
 */
export function fileRangeResponse({
  file,
  size,
  rangeHeader,
  headers = {},
  status = 200,
}: FileRangeResponseOptions): Response {
  const range = parseByteRange(rangeHeader, size)
  if (range.kind === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${size}` },
    })
  }
  if (range.kind === 'range') {
    return new Response(file.slice(range.start, range.end + 1), {
      status: 206,
      headers: {
        ...headers,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(range.end - range.start + 1),
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      },
    })
  }
  return new Response(file.slice(0, size), {
    status,
    headers: { ...headers, 'Accept-Ranges': 'bytes', 'Content-Length': String(size) },
  })
}
