// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Coverage for the ENOENT-fallback paths inside extractTarFastNonBlocking
// (lines 218-241 of s3-sync.ts). The mock for node:child_process is
// module-scoped because Bun's mock.module() runs eagerly at the top of the
// file before any imports — keeping this in a dedicated file means the
// rest of the s3-sync suite still gets the real spawn() for archive tests.
import { describe, expect, test, beforeEach, mock } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type SpawnMode = 'enoent' | 'eacces' | 'no-error'
const spawnState: { mode: SpawnMode } = { mode: 'enoent' }

function fakeChild() {
  return {
    stdout: { on: (_e: string, _h: (b: Buffer) => void) => {} },
    stderr: { on: (_e: string, _h: (b: Buffer) => void) => {} },
    once(ev: string, handler: (arg: unknown) => void) {
      if (ev === 'error' && spawnState.mode !== 'no-error') {
        queueMicrotask(() => {
          const e: NodeJS.ErrnoException = new Error(
            spawnState.mode === 'enoent' ? 'spawn tar ENOENT' : 'EACCES: permission denied',
          )
          e.code = spawnState.mode === 'enoent' ? 'ENOENT' : 'EACCES'
          handler(e)
        })
      }
    },
  }
}

mock.module('node:child_process', () => ({
  spawn: (..._args: unknown[]) => fakeChild(),
}))

const { extractTarFastNonBlocking } = await import('../s3-sync')

let TEST_DIR: string

beforeEach(() => {
  TEST_DIR = mkdtempSync(join(tmpdir(), 'shogo-s3-tar-fallback-'))
})

describe('extractTarFastNonBlocking — ENOENT fallback branches (mocked spawn)', () => {
  test('falls back to node-tar when system tar is missing (gz happy path)', async () => {
    spawnState.mode = 'enoent'
    const tar = await import('tar')
    const src = join(TEST_DIR, 'src')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'a.txt'), 'gz-fallback\n')
    const archive = join(TEST_DIR, 'fallback.tar.gz')
    await tar.create({ gzip: true, file: archive, cwd: src }, ['a.txt'])

    const dest = join(TEST_DIR, 'dest-gz')
    mkdirSync(dest, { recursive: true })
    const out = await extractTarFastNonBlocking(archive, dest)
    expect(out.usedBinary).toBe(false)
    expect(existsSync(join(dest, 'a.txt'))).toBe(true)
  })

  test('rejects clearly when system tar is missing AND archive is zstd', async () => {
    spawnState.mode = 'enoent'
    const archive = join(TEST_DIR, 'fallback.tar.zst')
    // First-byte 0x28 is what isZstd checks for (zstd magic 0x28 b5 2f fd).
    writeFileSync(archive, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0, 0, 0]))
    const dest = join(TEST_DIR, 'dest-zstd')
    mkdirSync(dest, { recursive: true })
    await expect(extractTarFastNonBlocking(archive, dest)).rejects.toThrow(
      /system tar missing and node-tar cannot decompress zstd/,
    )
  })

  test('rejects with the inner error when node-tar fallback also fails', async () => {
    spawnState.mode = 'enoent'
    const archive = join(TEST_DIR, 'corrupt.tar.gz')
    writeFileSync(archive, Buffer.from('definitely not gzip'))
    const dest = join(TEST_DIR, 'dest-corrupt')
    mkdirSync(dest, { recursive: true })
    await expect(extractTarFastNonBlocking(archive, dest)).rejects.toBeDefined()
  })

  test('rejects verbatim for non-ENOENT spawn errors (e.g. EACCES)', async () => {
    spawnState.mode = 'eacces'
    const archive = join(TEST_DIR, 'eacces.tar.gz')
    writeFileSync(archive, Buffer.from('whatever'))
    const dest = join(TEST_DIR, 'dest-eacces')
    mkdirSync(dest, { recursive: true })
    await expect(extractTarFastNonBlocking(archive, dest)).rejects.toThrow(/EACCES/)
  })
})
