// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `extractTarFastNonBlocking` in s3-sync.ts.
 *
 * This helper was introduced to fix the queue-proxy `/ready: context deadline
 * exceeded` failures we saw in staging, which traced back to a synchronous
 * `tar.extract()` blocking Bun's event loop for ~116s during S3 deps restore.
 *
 * The function:
 *   1. Spawns the system `tar` binary (extraction runs off the JS thread).
 *   2. Falls back to `node-tar` if the system binary is unavailable.
 *
 * These tests assert both paths produce a usable extraction tree AND that
 * the JS event loop stays responsive while extraction runs.
 *
 * Run: bun test packages/shared-runtime/src/__tests__/extract-tar-non-blocking.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { extractTarFastNonBlocking } from '../s3-sync'

let tmpRoot: string

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'shogo-tar-test-'))
})

afterAll(() => {
  if (tmpRoot && existsSync(tmpRoot)) {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
})

/**
 * Build a real .tar.gz on disk using the system tar binary so the test
 * archive matches what S3 actually delivers in production.
 */
function buildArchive(
  archivePath: string,
  files: Record<string, string>,
): void {
  const stage = mkdtempSync(join(tmpRoot, 'stage-'))
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(stage, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, contents)
  }
  const result = spawnSync('tar', ['-czf', archivePath, '-C', stage, '.'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  if (result.status !== 0) {
    throw new Error(`tar create failed: ${result.stderr?.toString() ?? ''}`)
  }
}

describe('extractTarFastNonBlocking', () => {
  test('extracts a small archive correctly via system tar', async () => {
    const archive = join(tmpRoot, 'small.tar.gz')
    buildArchive(archive, {
      'a.txt': 'hello',
      'nested/b.txt': 'world',
    })

    const target = mkdtempSync(join(tmpRoot, 'target-small-'))
    const { usedBinary } = await extractTarFastNonBlocking(archive, target)

    expect(usedBinary).toBe(true)
    expect(readFileSync(join(target, 'a.txt'), 'utf8')).toBe('hello')
    expect(readFileSync(join(target, 'nested', 'b.txt'), 'utf8')).toBe('world')
  })

  test('rejects with a useful error when archive is corrupt', async () => {
    const archive = join(tmpRoot, 'broken.tar.gz')
    writeFileSync(archive, 'not a real gzip stream')

    const target = mkdtempSync(join(tmpRoot, 'target-broken-'))
    let caught: any
    try {
      await extractTarFastNonBlocking(archive, target)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
    expect(String(caught.message)).toMatch(/tar -xzf exited with code/i)
  })

  test('event loop stays responsive while extracting a multi-MB archive', async () => {
    // Build a ~10MB archive — large enough that a synchronous extract would
    // visibly stall a 50ms-interval setInterval, but small enough to keep
    // the test fast.
    const archive = join(tmpRoot, 'big.tar.gz')
    const files: Record<string, string> = {}
    const blob = 'x'.repeat(64 * 1024) // 64 KB per file
    for (let i = 0; i < 200; i++) {
      files[`f${i}.bin`] = blob // ~12.8 MB pre-compression, gzip-compressible
    }
    buildArchive(archive, files)

    const target = mkdtempSync(join(tmpRoot, 'target-big-'))

    // Probe the event loop every 25ms during extraction. If the extraction
    // were synchronous (the bug we fixed), this interval would be starved
    // and we'd see far fewer ticks than expected.
    const ticks: number[] = []
    const probeStart = Date.now()
    const probe = setInterval(() => {
      ticks.push(Date.now() - probeStart)
    }, 25)

    const t0 = Date.now()
    const { usedBinary } = await extractTarFastNonBlocking(archive, target)
    const extractMs = Date.now() - t0
    clearInterval(probe)

    expect(usedBinary).toBe(true)

    // Sanity: archive really did extract a representative file.
    expect(readFileSync(join(target, 'f0.bin'), 'utf8').length).toBe(blob.length)

    // Look for the largest gap between consecutive ticks while extraction was
    // running. If the JS thread was blocked, this gap balloons. We allow up
    // to 200ms (8 missed ticks) to keep the test stable on noisy CI runners
    // — far below the multi-second stalls we used to see in staging.
    let maxGap = 0
    for (let i = 1; i < ticks.length; i++) {
      const gap = ticks[i] - ticks[i - 1]
      if (gap > maxGap) maxGap = gap
    }

    // Only enforce the responsiveness check when extraction was long enough
    // to actually exercise the event loop (>100ms). Tiny archives finish
    // before the probe even fires.
    if (extractMs > 100) {
      expect(maxGap).toBeLessThan(200)
    }
    // We must have observed *some* ticks during extraction.
    expect(ticks.length).toBeGreaterThan(0)
  })
})
