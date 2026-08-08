// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Streaming hydrate: pipe the request body into tar so the archive is never
 * held whole.
 *
 * Two earlier versions of this path each moved the cost instead of removing
 * it — `arrayBuffer()` charged the guest's RAM, a spool file charged its disk
 * twice — and both were caught only by running a multi-gigabyte archive in a
 * real microVM. The cases below are the ones that would have caught them
 * earlier: that a listing large enough to fill a pipe does not deadlock, that a
 * huge archive does not produce a proportional allocation, and that tar's exit
 * status is not swallowed.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractTarStream, scanTarOutput } from '../tar-stream'
import { archiveNeedsSidecarClear, SQLITE_SIDECAR_ENTRY } from '../writable-state'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tar-stream-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function sh(cmd: string[]): Promise<void> {
  const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
  const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()])
  if (code !== 0) throw new Error(`${cmd.join(' ')} exited ${code}: ${err}`)
}

/** Build a .tar.gz from a described tree and return a body stream over it. */
async function archiveOf(files: Record<string, string | Uint8Array>): Promise<ReadableStream<Uint8Array>> {
  const src = join(dir, `src-${Math.random().toString(36).slice(2)}`)
  for (const [rel, content] of Object.entries(files)) {
    const full = join(src, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content as any)
  }
  const tgz = join(dir, `a-${Math.random().toString(36).slice(2)}.tar.gz`)
  await sh(['tar', '-czf', tgz, '-C', src, '.'])
  return Bun.file(tgz).stream() as unknown as ReadableStream<Uint8Array>
}

function outDir(): string {
  const out = join(dir, `out-${Math.random().toString(36).slice(2)}`)
  mkdirSync(out, { recursive: true })
  return out
}

describe('extractTarStream', () => {
  test('extracts a tree from the stream and reports the bytes it read', async () => {
    const out = outDir()
    const body = await archiveOf({ 'a.txt': 'hello', 'src/b.ts': 'export const b = 1\n' })

    const res = await extractTarStream(body, out, SQLITE_SIDECAR_ENTRY)

    expect(readFileSync(join(out, 'a.txt'), 'utf8')).toBe('hello')
    expect(readFileSync(join(out, 'src/b.ts'), 'utf8')).toBe('export const b = 1\n')
    expect(res.bytes).toBeGreaterThan(0)
  })

  test('returns only the paths the caller asked for', async () => {
    // The filter is what keeps a 200k-file project from allocating a 200k-entry
    // array on the path whose entire purpose is to avoid size-proportional
    // allocation.
    const out = outDir()
    const body = await archiveOf({
      'prisma/dev.db': 'sqlite',
      'src/one.ts': '1',
      'src/two.ts': '2',
      'assets/big.bin': 'x'.repeat(1000),
    })

    const res = await extractTarStream(body, out, SQLITE_SIDECAR_ENTRY)

    expect(res.matched.map((m) => m.replace(/^\.\//, ''))).toEqual(['prisma/dev.db'])
    // Everything still lands on disk; only the LISTING is filtered.
    expect(existsSync(join(out, 'src/two.ts'))).toBe(true)
    expect(existsSync(join(out, 'assets/big.bin'))).toBe(true)
  })

  test('feeds archiveNeedsSidecarClear correctly for a db-without-wal archive', async () => {
    // The filtered listing has to be a faithful substitute for the full one, or
    // a restored database gets silently reverted by a stale WAL.
    const out = outDir()
    const withoutWal = await extractTarStream(await archiveOf({ 'prisma/dev.db': 'db' }), out, SQLITE_SIDECAR_ENTRY)
    expect(archiveNeedsSidecarClear(withoutWal.matched)).toBe(true)

    const out2 = outDir()
    const withWal = await extractTarStream(
      await archiveOf({ 'prisma/dev.db': 'db', 'prisma/dev.db-wal': 'wal' }),
      out2,
      SQLITE_SIDECAR_ENTRY,
    )
    expect(archiveNeedsSidecarClear(withWal.matched)).toBe(false)
  })

  test('does not deadlock when the listing is far larger than a pipe buffer', async () => {
    // THE DEADLOCK CASE. `tar -v` prints a line per file; a pipe holds ~64 KB.
    // If the caller writes the whole body before reading stdout, tar blocks on
    // its listing, stops reading the archive, and both sides wait forever. Only
    // reproduces above a few thousand files, which is every real project and no
    // toy fixture.
    const files: Record<string, string> = {}
    for (let i = 0; i < 6000; i++) files[`deep/dir-${i % 50}/file-${i}-with-a-long-enough-name.ts`] = `${i}`
    const out = outDir()

    const res = await Promise.race([
      extractTarStream(await archiveOf(files), out, /file-42-/),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('deadlocked')), 60_000)),
    ])

    expect(res.matched.length).toBe(1)
    expect(existsSync(join(out, 'deep/dir-49/file-5999-with-a-long-enough-name.ts'))).toBe(true)
  }, 70_000)

  test('surfaces tar’s exit code and its diagnostics', async () => {
    // Hydrate is fail-closed: the host destroys the VM on failure. Swallowing a
    // non-zero exit would instead hand back a half-extracted workspace that
    // looks fine, which is how a project silently opens as a template.
    const out = outDir()
    const notATarball = new Blob([new Uint8Array(2048).fill(7)]).stream() as unknown as ReadableStream<Uint8Array>

    await expect(extractTarStream(notATarball, out, /x/)).rejects.toThrow(/tar exited [1-9]/)
  })

  test('reports ENOSPC-style failures rather than reporting success', async () => {
    const out = join(dir, 'does-not-exist')
    await expect(extractTarStream(await archiveOf({ 'a.txt': 'x' }), out, /x/)).rejects.toThrow(/tar exited/)
  })

  test('settles on an empty body instead of hanging', async () => {
    // GNU tar treats a zero-length archive as an error and bsdtar does not, so
    // the portable guarantee is only that this RETURNS — the caller rejects
    // `bytes === 0` itself rather than relying on tar to.
    const out = outDir()
    const empty = new Blob([]).stream() as unknown as ReadableStream<Uint8Array>

    const settled = await Promise.race([
      extractTarStream(empty, out, /x/).then(
        (r) => ({ ok: true as const, bytes: r.bytes }),
        () => ({ ok: false as const, bytes: 0 }),
      ),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('hung on empty body')), 15_000)),
    ])

    expect(settled.bytes).toBe(0)
  }, 20_000)

  test('memory stays flat across an archive far larger than any buffer', async () => {
    // The regression in one number. A 256 MB incompressible archive through a
    // handler that holds it whole shows up as a matching jump in RSS; through
    // this one it does not.
    const out = outDir()
    const big = join(dir, 'big.bin')
    await sh(['dd', 'if=/dev/urandom', `of=${big}`, 'bs=1048576', 'count=256', 'status=none'])
    const srcDir = join(dir, 'bigsrc')
    mkdirSync(srcDir, { recursive: true })
    await sh(['mv', big, join(srcDir, 'big.bin')])
    const tgz = join(dir, 'big.tar.gz')
    await sh(['tar', '-czf', tgz, '-C', srcDir, '.'])

    Bun.gc(true)
    const before = process.memoryUsage.rss()
    const res = await extractTarStream(
      Bun.file(tgz).stream() as unknown as ReadableStream<Uint8Array>,
      out,
      /nothing/,
    )
    Bun.gc(true)
    const grewMb = (process.memoryUsage.rss() - before) / 1024 / 1024

    expect(res.bytes).toBeGreaterThan(200 * 1024 * 1024)
    // Deliberately loose. The failure being guarded is growth PROPORTIONAL to
    // the archive — an earlier version of this that handed the stream to Bun
    // peaked at +2.4 GB on a 1 GB archive — so the bound only has to sit well
    // below 256 MB, not track GC timing.
    expect(grewMb).toBeLessThan(128)
  }, 120_000)
})

describe('scanTarOutput', () => {
  function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder()
    return new ReadableStream({
      start(c) {
        for (const s of chunks) c.enqueue(enc.encode(s))
        c.close()
      },
    })
  }
  const matched = async (...chunks: string[]) =>
    (await scanTarOutput(streamOf(...chunks), SQLITE_SIDECAR_ENTRY)).matched

  test('reassembles lines split across chunk boundaries', async () => {
    // tar's output arrives in pipe-sized reads with no regard for line ends, so
    // a path can straddle two chunks.
    expect(await matched('./prisma/de', 'v.db\n./src/a.ts\n')).toEqual(['./prisma/dev.db'])
  })

  test('keeps a final line with no trailing newline', async () => {
    expect(await matched('./src/a.ts\n./prisma/dev.db')).toEqual(['./prisma/dev.db'])
  })

  test('strips the bsdtar "x " prefix so both tars agree', async () => {
    // GNU tar prints the bare path, bsdtar prefixes it. Left unnormalized, the
    // sidecar comparison downstream succeeds on Linux and fails on macOS — and
    // the consequence of failing is a restored database silently reverted by a
    // stale WAL, not a visible error.
    expect(await matched('x ./prisma/dev.db\n')).toEqual(['./prisma/dev.db'])
  })

  test('does not mistake a multi-byte character split across chunks', async () => {
    const bytes = new TextEncoder().encode('./caf\u00e9/prisma/dev.db\n')
    const cut = 7 // lands inside the two-byte é
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, cut))
        c.enqueue(bytes.slice(cut))
        c.close()
      },
    })
    expect((await scanTarOutput(stream, SQLITE_SIDECAR_ENTRY)).matched).toEqual(['./café/prisma/dev.db'])
  })

  test('ignores blank lines and returns nothing when there is no match', async () => {
    expect(await matched('\n\n./src/a.ts\n\n')).toEqual([])
  })

  test('does not treat a diagnostic mentioning the database as an entry', async () => {
    // stderr carries both the listing (bsdtar) and error text, so the filter
    // has to tell "extracted this" from "failed on this".
    expect(await matched('tar: ./prisma/dev.db: Cannot write: No space left on device\n')).toEqual([])
  })

  test('caps the diagnostic tail instead of buffering the stream', async () => {
    const noise = 'x'.repeat(100_000)
    const { tail } = await scanTarOutput(streamOf(noise + '\nlast line\n'), /nothing/, 1024)
    expect(tail.length).toBeLessThanOrEqual(1024)
    expect(tail).toContain('last line')
  })
})
