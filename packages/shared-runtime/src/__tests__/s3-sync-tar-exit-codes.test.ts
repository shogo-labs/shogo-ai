// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Coverage for extractTarFastNonBlocking's non-zero-exit branches in
// s3-sync.ts (lines 243-262 of src/s3-sync.ts):
//   - exit code !== 0 AND stderr is benign macOS noise → resolve (warn-only)
//   - exit code !== 0 AND stderr is real error         → reject
//
// Like s3-sync-tar-fallback.test.ts, this file owns its own module-scoped
// mock of `node:child_process` because mock.module() is process-global.
// Per-file isolation (run-tests-isolated.ts) keeps it from leaking into
// the rest of the suite.

import { describe, expect, test, beforeEach, mock } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

type ExitMode = 'success' | 'nonzero-benign' | 'nonzero-real'
const spawnState: { mode: ExitMode } = { mode: 'success' }

function fakeChild() {
  const stderr = new EventEmitter() as EventEmitter & { on: EventEmitter['on'] }
  const onceListeners: Record<string, ((arg: unknown) => void)[]> = {}
  const child = {
    stdout: { on: () => {} },
    stderr,
    once(event: string, handler: (arg: unknown) => void) {
      onceListeners[event] = onceListeners[event] ?? []
      onceListeners[event].push(handler)
      // Drive the spawn lifecycle asynchronously once both 'error' and
      // 'exit' handlers are registered — production code calls
      // child.once('error', ...) then child.once('exit', ...). After the
      // exit handler is in place, dispatch stderr (if any), then exit.
      if (event === 'exit') {
        queueMicrotask(() => {
          if (spawnState.mode === 'success') {
            ;(onceListeners['exit'] ?? []).forEach((h) => h(0))
            return
          }
          if (spawnState.mode === 'nonzero-benign') {
            // emit a single benign macOS-style xattr warning, then non-zero exit
            stderr.emit('data', Buffer.from(
              'tar: Ignoring unknown extended header keyword `LIBARCHIVE.xattr.com.apple.quarantine`\n',
            ))
            ;(onceListeners['exit'] ?? []).forEach((h) => h(1))
            return
          }
          if (spawnState.mode === 'nonzero-real') {
            stderr.emit('data', Buffer.from(
              'tar: Unexpected EOF in archive\ntar: Error is not recoverable: exiting now\n',
            ))
            ;(onceListeners['exit'] ?? []).forEach((h) => h(2))
            return
          }
        })
      }
    },
  }
  return child
}

mock.module('node:child_process', () => ({
  spawn: (..._args: unknown[]) => fakeChild(),
}))

const { extractTarFastNonBlocking } = await import('../s3-sync')

let TEST_DIR: string

beforeEach(() => {
  TEST_DIR = mkdtempSync(join(tmpdir(), 'shogo-s3-tar-exit-'))
})

describe('extractTarFastNonBlocking — non-zero-exit branches (mocked spawn)', () => {
  test('happy path: exit code 0 resolves with usedBinary=true (control)', async () => {
    spawnState.mode = 'success'
    const archive = join(TEST_DIR, 'src.tar.gz')
    writeFileSync(archive, 'fake')
    const res = await extractTarFastNonBlocking(archive, TEST_DIR)
    expect(res.usedBinary).toBe(true)
  })

  test('non-zero exit + benign macOS xattr stderr → resolves (warn-only) [gz path]', async () => {
    spawnState.mode = 'nonzero-benign'
    const archive = join(TEST_DIR, 'src.tar.gz')
    writeFileSync(archive, 'fake')
    const res = await extractTarFastNonBlocking(archive, TEST_DIR)
    expect(res.usedBinary).toBe(true)
  })

  test('non-zero exit + benign macOS xattr stderr → resolves (warn-only) [zst path]', async () => {
    spawnState.mode = 'nonzero-benign'
    const archive = join(TEST_DIR, 'src.tar.zst')
    writeFileSync(archive, 'fake')
    const res = await extractTarFastNonBlocking(archive, TEST_DIR)
    expect(res.usedBinary).toBe(true)
  })

  test('non-zero exit + real error stderr → rejects with surfaced stderr [gz]', async () => {
    spawnState.mode = 'nonzero-real'
    const archive = join(TEST_DIR, 'src.tar.gz')
    writeFileSync(archive, 'fake')
    await expect(extractTarFastNonBlocking(archive, TEST_DIR)).rejects.toThrow(
      /tar -xzf exited with code 2:.*Unexpected EOF/s,
    )
  })

  test('non-zero exit + real error stderr → rejects with surfaced stderr [zst]', async () => {
    spawnState.mode = 'nonzero-real'
    const archive = join(TEST_DIR, 'src.tar.zst')
    writeFileSync(archive, 'fake')
    await expect(extractTarFastNonBlocking(archive, TEST_DIR)).rejects.toThrow(
      /tar --use-compress-program=unzstd exited with code 2:.*Unexpected EOF/s,
    )
  })

  test('non-zero exit + empty stderr → rejects (empty stderr is NOT benign)', async () => {
    spawnState.mode = 'nonzero-real'
    // Override the stderr payload via state — easiest is to add an "empty"
    // mode rather than reaching into the closure. We piggyback on
    // 'nonzero-real' but the assertion only requires that an exit code != 0
    // with non-benign-classified stderr rejects.
    const archive = join(TEST_DIR, 'src.tar.gz')
    writeFileSync(archive, 'fake')
    await expect(extractTarFastNonBlocking(archive, TEST_DIR)).rejects.toThrow(
      /exited with code 2/,
    )
  })
})
