// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The bug this file exists for: `/pool/hydrate` was changed to spool its body
 * to a file "instead of holding it in memory", and the file went to
 * `os.tmpdir()`. In the guest that is a tmpfs sized at half of RAM, so the
 * spool was memory with extra steps — a 1.9 GB hydrate killed the microVM
 * outright while every unit test and a 2 GiB local run passed, because on a
 * developer machine `/tmp` is a real disk.
 *
 * So the tests that matter here are the ones that distinguish those two
 * environments, which means simulating a RAM-backed temp dir rather than
 * trusting whatever the test host happens to mount.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { isRamBacked, resetSpoolDir, resolveSpoolDir, spoolPath, spooledFileResponse, sweepSpool, type SpoolProbe } from '../spool'

let dir: string
let realTmpdir: string | undefined
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spool-test-'))
  // The tests that go through the real probe would otherwise resolve to the
  // machine's shared temp dir and sweep it — deleting other runs' files, and
  // failing whenever a previous run left one behind. `os.tmpdir()` reads TMPDIR
  // on each call, so redirecting it gives each test its own spool.
  realTmpdir = process.env.TMPDIR
  process.env.TMPDIR = join(dir, 'systmp')
  mkdirSync(process.env.TMPDIR, { recursive: true })
  resetSpoolDir()
})
afterEach(() => {
  if (realTmpdir === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = realTmpdir
  rmSync(dir, { recursive: true, force: true })
  resetSpoolDir()
})

/** A probe with a real filesystem underneath but a scripted view of what is RAM. */
function probe(opts: { tmp: string; ram?: string[]; unwritable?: string[] }): SpoolProbe {
  const ram = opts.ram ?? []
  const unwritable = opts.unwritable ?? []
  return {
    tmpdir: () => opts.tmp,
    isRamBacked: (p) => ram.some((r) => p === r || p.startsWith(r + '/')),
    ensureWritable: (p) => {
      if (unwritable.some((u) => p === u || p.startsWith(u + '/'))) return false
      mkdirSync(p, { recursive: true })
      return true
    },
  }
}

describe('resolveSpoolDir', () => {
  test('uses the temp dir when it is real disk, so normal environments are unchanged', () => {
    const tmp = join(dir, 'tmp')
    const chosen = resolveSpoolDir(join(dir, 'app/workspace'), probe({ tmp }))
    expect(chosen).toBe(join(tmp, 'shogo-spool'))
  })

  test('THE GUEST CASE: a RAM-backed temp dir is refused in favour of disk', () => {
    // This is the regression. `/tmp` exists, is writable, and passes every
    // check a spool implementation would normally make — it just happens to be
    // memory, which is the one property that matters at 2 GB.
    const tmp = join(dir, 'tmp')
    const workspace = join(dir, 'app/workspace')
    const chosen = resolveSpoolDir(workspace, probe({ tmp, ram: [tmp] }))
    expect(chosen).toBe(join(dir, 'app/.shogo-spool'))
    expect(chosen).not.toContain(tmp)
  })

  test('the fallback is a sibling of the workspace, never inside it', () => {
    // Anything under the workspace is swept into `packProjectArchive` and
    // shipped to durable storage, so a spool file there would be uploaded as
    // if the user had written it — and would land back in the workspace on the
    // next hydrate.
    const workspace = join(dir, 'app/workspace')
    const chosen = resolveSpoolDir(workspace, probe({ tmp: join(dir, 'tmp'), ram: [join(dir, 'tmp')] }))
    expect(chosen.startsWith(workspace)).toBe(false)
    expect(dirname(chosen)).toBe(dirname(workspace))
  })

  test('skips a candidate it cannot actually write to', () => {
    // mkdir succeeding does not mean writable: read-only mount, full disk,
    // wrong owner. Discovering that at 2 GB is too late.
    const tmp = join(dir, 'tmp')
    const workspace = join(dir, 'app/workspace')
    const chosen = resolveSpoolDir(workspace, probe({ tmp, unwritable: [tmp] }))
    expect(chosen).toBe(join(dir, 'app/.shogo-spool'))
  })

  test('falls back to temp and warns when everything reachable is RAM', () => {
    const tmp = join(dir, 'tmp')
    const workspace = join(dir, 'app/workspace')
    const warnings: string[] = []
    const orig = console.warn
    console.warn = (m: any) => warnings.push(String(m))
    try {
      const chosen = resolveSpoolDir(workspace, probe({ tmp, ram: [tmp, join(dir, 'app')] }))
      expect(chosen).toBe(join(tmp, 'shogo-spool'))
    } finally {
      console.warn = orig
    }
    // Silently doing the dangerous thing is how this bug shipped the first time.
    expect(warnings.join(' ')).toContain('RAM-backed')
  })
})

describe('isRamBacked', () => {
  const linux = process.platform === 'linux'
  const onLinux = linux ? test : test.skip

  onLinux('recognises a real tmpfs and a real disk', () => {
    // /dev/shm is tmpfs on every Linux worth running this on; the repo root is
    // not. Pinned against the actual kernel rather than a mock, because the
    // magic number is the whole load-bearing detail.
    expect(isRamBacked('/dev/shm')).toBe(true)
    expect(isRamBacked(process.cwd())).toBe(false)
  })

  test('answers false for a path it cannot stat rather than throwing', () => {
    // Callers use this to choose a directory; an exception here would take out
    // hydrate entirely, which is fail-closed.
    expect(isRamBacked(join(dir, 'does/not/exist'))).toBe(false)
  })
})

describe('sweepSpool', () => {
  test('removes files left by a killed request but keeps live ones', () => {
    const ws = join(dir, 'app/workspace')
    mkdirSync(ws, { recursive: true })
    const spool = spoolPath('x.tar.gz', ws)
    mkdirSync(dirname(spool), { recursive: true })

    const stale = join(dirname(spool), 'stale.tar.gz')
    const fresh = join(dirname(spool), 'fresh.tar.gz')
    writeFileSync(stale, 'old')
    writeFileSync(fresh, 'new')
    const longAgo = new Date(Date.now() - 3 * 60 * 60 * 1000)
    utimesSync(stale, longAgo, longAgo)

    expect(sweepSpool(60 * 60 * 1000, ws)).toBe(1)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  test('is silent about a spool directory that does not exist yet', () => {
    expect(() => sweepSpool(1000, join(dir, 'nope/workspace'))).not.toThrow()
  })
})

describe('spooledFileResponse', () => {
  async function drain(res: Response): Promise<{ bytes: number; chunks: number }> {
    const reader = res.body!.getReader()
    let bytes = 0
    let chunks = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value!.byteLength
      chunks++
    }
    return { bytes, chunks }
  }

  test('serves the exact bytes and reports the length', async () => {
    const p = join(dir, 'a.tar.gz')
    const payload = Buffer.from('hello archive'.repeat(1000))
    writeFileSync(p, payload)

    const res = await spooledFileResponse(p, { 'Content-Type': 'application/gzip' })
    expect(res.headers.get('Content-Length')).toBe(String(payload.length))
    expect(res.headers.get('Content-Type')).toBe('application/gzip')
    expect(Buffer.from(await res.arrayBuffer()).equals(payload)).toBe(true)
  })

  test('unlinks before sending, yet still serves the whole file', async () => {
    // The unlink is deliberately up front so a client that hangs up mid-download
    // cannot leave a multi-gigabyte file on a guest disk that has no room for
    // it. POSIX keeps the inode alive for our descriptor, which is what makes
    // that safe — this test is the proof.
    const p = join(dir, 'b.tar.gz')
    const payload = Buffer.alloc(3 * 1024 * 1024, 7)
    writeFileSync(p, payload)

    const res = await spooledFileResponse(p, {})
    expect(existsSync(p)).toBe(false)

    const got = Buffer.from(await res.arrayBuffer())
    expect(got.length).toBe(payload.length)
    expect(got.equals(payload)).toBe(true)
  })

  test('streams in chunks instead of materialising the archive', async () => {
    // The structural version of "does not hold 1.8 GB in RAM": a file several
    // times the chunk size must arrive as several chunks. Deterministic, unlike
    // watching RSS.
    const p = join(dir, 'c.tar.gz')
    writeFileSync(p, Buffer.alloc(5 * 1024 * 1024, 3))

    const { bytes, chunks } = await drain(await spooledFileResponse(p, {}))
    expect(bytes).toBe(5 * 1024 * 1024)
    expect(chunks).toBeGreaterThan(1)
  })

  test('releases the file when the caller abandons the download', async () => {
    const p = join(dir, 'd.tar.gz')
    writeFileSync(p, Buffer.alloc(4 * 1024 * 1024, 1))

    const res = await spooledFileResponse(p, {})
    const reader = res.body!.getReader()
    await reader.read()
    await reader.cancel()

    // Already unlinked, so the space is reclaimed once the descriptor closes.
    expect(existsSync(p)).toBe(false)
  })

  test('closes the descriptor and rethrows when the spool file vanishes', async () => {
    // The caller's `finally` decides whether to unlink based on whether this
    // returned, so it has to actually throw rather than hand back a Response
    // with a zero Content-Length and a stream that disagrees.
    await expect(spooledFileResponse(join(dir, 'missing.tar.gz'), {})).rejects.toThrow()
  })

  test('survives the stage directory being removed out from under it', async () => {
    // `/pool/export-data` deletes its whole staging directory in a `finally`
    // that runs before the response is consumed.
    const stage = join(dir, 'stage')
    mkdirSync(stage, { recursive: true })
    const p = join(stage, 'data.tar.gz')
    const payload = Buffer.alloc(2 * 1024 * 1024, 9)
    writeFileSync(p, payload)

    const res = await spooledFileResponse(p, {})
    rmSync(stage, { recursive: true, force: true })

    expect(Buffer.from(await res.arrayBuffer()).equals(payload)).toBe(true)
  })
})

describe('spoolPath', () => {
  test('does not collide when called twice in the same millisecond', () => {
    const ws = join(dir, 'app/workspace')
    const a = spoolPath('x.tar.gz', ws)
    const b = spoolPath('x.tar.gz', ws)
    expect(a).not.toBe(b)
  })

  test('keeps the caller-supplied suffix so a spool file is identifiable', () => {
    expect(spoolPath('pool-hydrate.tar.gz', join(dir, 'app/workspace'))).toEndWith('pool-hydrate.tar.gz')
  })
})
