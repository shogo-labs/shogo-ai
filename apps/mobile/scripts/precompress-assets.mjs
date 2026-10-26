// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Writes `<file>.br` (brotli q11) and `<file>.gz` (gzip -9) next to every
// compressible asset under the given directory (default: dist/_expo).
//
// nginx serves these as-is (see nginx.conf `location ^~ /_expo/`), and
// Cloudflare passes origin `content-encoding: br` straight through to the
// browser. On-the-fly compression can't afford q11: nginx's gzip sent the
// 12.3 MB __common chunk as 3.08 MB, Cloudflare's own brotli as ~2.5 MB,
// brotli q11 done once at build time sends 1.78 MB (PERF-5).

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

const EXTENSIONS = new Set(['.js', '.css'])
const MIN_BYTES = 1024

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (entry.isFile()) yield path
  }
}

function extension(path) {
  const dot = path.lastIndexOf('.')
  return dot === -1 ? '' : path.slice(dot)
}

export function precompress(root) {
  const stats = { files: 0, raw: 0, br: 0, gz: 0 }
  for (const path of walk(root)) {
    if (!EXTENSIONS.has(extension(path))) continue
    const size = statSync(path).size
    if (size < MIN_BYTES) continue
    const raw = readFileSync(path)
    const br = brotliCompressSync(raw, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
        [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
        [constants.BROTLI_PARAM_LGWIN]: constants.BROTLI_MAX_WINDOW_BITS,
        [constants.BROTLI_PARAM_SIZE_HINT]: size,
      },
    })
    const gz = gzipSync(raw, { level: 9 })
    // A compressed copy that isn't smaller is never worth serving.
    if (br.length < size) writeFileSync(`${path}.br`, br)
    if (gz.length < size) writeFileSync(`${path}.gz`, gz)
    stats.files++
    stats.raw += size
    stats.br += Math.min(br.length, size)
    stats.gz += Math.min(gz.length, size)
  }
  return stats
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2] ?? 'dist/_expo'
  const { files, raw, br, gz } = precompress(root)
  if (files === 0) {
    console.error(`precompress-assets: no compressible files under ${root}`)
    process.exit(1)
  }
  const mb = (n) => (n / 1e6).toFixed(2)
  console.log(
    `precompress-assets: ${files} files, ${mb(raw)} MB raw -> ${mb(br)} MB br / ${mb(gz)} MB gz`,
  )
}
