// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * AC3 of SHO-593: an export path's memory must not grow with the body.
 *
 * The bug was a whole-artifact buffer, so the property that has to be pinned is
 * memory-vs-size, not "the file round-trips". Each case runs the real path in a
 * child process over a body 4x the bound and checks the child's peak RSS stayed
 * under it — a buffered implementation fails by construction (it would hold the
 * whole body), and the bound is coarse enough not to flake on allocator noise.
 *
 * Sizes are modest on purpose: the assertion is about the SHAPE, and a 512 MiB
 * fixture catches a buffer just as well as a 4 GiB one while keeping CI quick.
 */

import { describe, expect, test } from 'bun:test'
import { join } from 'path'

const CHILD = join(import.meta.dir, 'test-fixtures/spool-memory-child.ts')

type Mode = 'spool' | 'gzip'

/** Run one path over `mib` mebibytes and report the child's peak RSS. */
function run(mode: Mode, mib: number): { srcBytes: number; outBytes: number; peakMib: number } {
  const proc = Bun.spawnSync([process.execPath, CHILD, mode, String(mib)], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = proc.stdout.toString()
  const line = out.trim().split('\n').pop() ?? ''
  if (proc.exitCode !== 0 || !line.startsWith('{')) {
    throw new Error(`${mode} child failed (${proc.exitCode}): ${out || proc.stderr.toString()}`)
  }
  const j = JSON.parse(line)
  return { srcBytes: j.src_bytes, outBytes: j.out_bytes, peakMib: j.peak_rss_mib }
}

describe('export paths keep memory flat as the body grows', () => {
  test('spooling a guest export holds one chunk, not the body', () => {
    const mib = 512
    const { srcBytes, outBytes, peakMib } = run('spool', mib)
    expect(srcBytes).toBe(mib * 1024 * 1024)
    // The spool wrote the whole body…
    expect(outBytes).toBe(srcBytes)
    // …while staying far under it. Before the spool this path held the body
    // whole (33.6 GiB for a 4.3 GiB export), so a buffered regression lands at
    // ~512 MiB here and trips the bound.
    expect(peakMib).toBeLessThan(192)
  }, 120_000)

  test('a snapshot push gzips to a file and uploads a file body', () => {
    const mib = 256
    const { srcBytes, outBytes, peakMib } = run('gzip', mib)
    expect(srcBytes).toBe(mib * 1024 * 1024)
    // pigz compressed it (zeros compress hard, so only assert it is non-empty
    // and clearly smaller than the source).
    expect(outBytes).toBeGreaterThan(0)
    expect(outBytes).toBeLessThan(srcBytes)
    // The 94 GiB burst came from this path; a CompressionStream body would sit
    // at ~256 MiB+ here, the pigz + file-body shape stays in the tens.
    expect(peakMib).toBeLessThan(192)
  }, 120_000)
})
