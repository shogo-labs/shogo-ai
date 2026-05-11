// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Unit tests for the *Async siblings of execToolSync / prismaGenerate /
// prismaDbPush in platform-pkg.ts.
//
// The sync wrappers shell out via `nodeExecSync`, which holds Bun's
// single JS thread for the full duration of the child process. That's
// what caused /pool/assign to freeze for ~4.7s in staging on 2026-05-11
// (prisma generate ~2.9s + prisma db push ~1.6s, both spawned by the
// preview manager inside the assign hot path). The async variants use
// spawn() and must keep the event loop responsive throughout.
//
// We exercise this by pointing `SHOGO_BUN_PATH` at a tiny shell script
// that sleeps and then exits 0, then asserting:
//
//   1. The returned promise resolves only after the sleep completes.
//   2. A 25ms setInterval probe collects ticks during the sleep — i.e.
//      the event loop was *not* blocked.
//   3. Non-zero exit codes surface as a rejection containing stderr.
//   4. The timeout option fires SIGKILL and rejects with a timeout error.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PlatformPackageManager } from '../platform-pkg'

let tmpRoot: string
let fakeBunOk: string
let fakeBunFail: string
let fakeBunHang: string

const IS_WINDOWS = process.platform === 'win32'

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'shogo-platform-pkg-async-'))

  // Each fake bun is a small shell script that pretends to be the bun
  // binary. We do NOT actually run `bun x prisma generate`; we just need
  // a child process that takes a measurable amount of wall time and
  // returns the exit code we want to test against.
  //
  // PlatformPackageManager.execToolAsync (non-windows path) spawns the
  // bun binary with argv = ['x', '--bun'?, tool, ...args]. The fake
  // ignores those args and behaves according to the script's hardcoded
  // exit / sleep policy.
  fakeBunOk = join(tmpRoot, 'fake-bun-ok.sh')
  writeFileSync(
    fakeBunOk,
    '#!/usr/bin/env bash\nsleep 0.3\necho "fake bun ok"\nexit 0\n',
  )
  chmodSync(fakeBunOk, 0o755)

  fakeBunFail = join(tmpRoot, 'fake-bun-fail.sh')
  writeFileSync(
    fakeBunFail,
    '#!/usr/bin/env bash\necho "boom on stderr" >&2\nexit 17\n',
  )
  chmodSync(fakeBunFail, 0o755)

  fakeBunHang = join(tmpRoot, 'fake-bun-hang.sh')
  writeFileSync(
    fakeBunHang,
    '#!/usr/bin/env bash\nsleep 30\nexit 0\n',
  )
  chmodSync(fakeBunHang, 0o755)
})

afterAll(() => {
  if (tmpRoot && existsSync(tmpRoot)) {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
})

function makePkg(bunPath: string): PlatformPackageManager {
  // We can't pass bunPath as a constructor arg — the class reads
  // process.env.SHOGO_BUN_PATH lazily through its `bunBinary` getter.
  process.env.SHOGO_BUN_PATH = bunPath
  return new PlatformPackageManager()
}

describe('execToolAsync (event loop)', () => {
  test('event loop stays responsive while the child sleeps', async () => {
    if (IS_WINDOWS) return // fake-bun shell scripts assume POSIX
    const pkg = makePkg(fakeBunOk)

    const ticks: number[] = []
    const probeStart = Date.now()
    const probe = setInterval(() => {
      ticks.push(Date.now() - probeStart)
    }, 25)

    const t0 = Date.now()
    await pkg.execToolAsync('any-tool', ['any-arg'], tmpRoot, { timeout: 5_000 })
    const elapsed = Date.now() - t0
    clearInterval(probe)

    // Fake binary sleeps 0.3s — sanity-check we actually waited.
    expect(elapsed).toBeGreaterThanOrEqual(250)

    // If the call were sync, the 25ms probe would have fired 0 times
    // during the sleep. Assert at least a few ticks landed inside the
    // sleep window — generous lower bound to absorb CI jitter.
    expect(ticks.length).toBeGreaterThan(3)

    // No gap between consecutive ticks should exceed 250ms (10 missed
    // ticks). The sync variant would produce a single ~300ms gap.
    let maxGap = 0
    for (let i = 1; i < ticks.length; i++) {
      const gap = ticks[i]! - ticks[i - 1]!
      if (gap > maxGap) maxGap = gap
    }
    expect(maxGap).toBeLessThan(250)
  })

  test('rejects with stderr message on non-zero exit', async () => {
    if (IS_WINDOWS) return
    const pkg = makePkg(fakeBunFail)
    let err: any = null
    try {
      await pkg.execToolAsync('any-tool', [], tmpRoot, { timeout: 5_000 })
    } catch (e) {
      err = e
    }
    expect(err).not.toBeNull()
    expect(String(err.message)).toMatch(/boom on stderr/i)
  })

  test('honors timeout option (SIGKILLs and rejects)', async () => {
    if (IS_WINDOWS) return
    const pkg = makePkg(fakeBunHang)
    const t0 = Date.now()
    let err: any = null
    try {
      // 150ms timeout — far shorter than the 30s sleep in fakeBunHang.
      await pkg.execToolAsync('any-tool', [], tmpRoot, { timeout: 150 })
    } catch (e) {
      err = e
    }
    const elapsed = Date.now() - t0
    expect(err).not.toBeNull()
    expect(String(err.message)).toMatch(/timed out after 150ms/i)
    // Must have actually waited at least the timeout — not just rejected
    // synchronously from a misconfigured spawn.
    expect(elapsed).toBeGreaterThanOrEqual(120)
    // And must NOT have waited for the 30s sleep.
    expect(elapsed).toBeLessThan(2_000)
  })
})

describe('prismaGenerateAsync / prismaDbPushAsync', () => {
  // These are 1-line wrappers around execToolAsync, so we only smoke-test
  // that they delegate correctly (resolve on success, reject on failure)
  // — execToolAsync above carries the heavy coverage.
  test('prismaGenerateAsync resolves when the fake bun exits 0', async () => {
    if (IS_WINDOWS) return
    const pkg = makePkg(fakeBunOk)
    await pkg.prismaGenerateAsync(tmpRoot, { timeout: 5_000 })
  })

  test('prismaDbPushAsync resolves when the fake bun exits 0', async () => {
    if (IS_WINDOWS) return
    const pkg = makePkg(fakeBunOk)
    await pkg.prismaDbPushAsync(tmpRoot, { timeout: 5_000 })
  })

  test('prismaDbPushAsync rejects when the child exits non-zero', async () => {
    if (IS_WINDOWS) return
    const pkg = makePkg(fakeBunFail)
    let err: any = null
    try {
      await pkg.prismaDbPushAsync(tmpRoot, { timeout: 5_000 })
    } catch (e) {
      err = e
    }
    expect(err).not.toBeNull()
    expect(String(err.message)).toMatch(/prisma db push failed/i)
  })
})
