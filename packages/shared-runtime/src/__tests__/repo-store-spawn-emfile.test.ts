// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// When the process is out of file descriptors, Bun's `child_process.spawn`
// cannot create the stdio pipes: it returns a child whose `stdout`/`stderr`
// are `undefined` and reports EMFILE through the 'error' event. The metal
// `/pool/export-repo` path used to dereference `child.stderr.on` and 500 with
// "undefined is not an object", so no `.git` ever reached durable storage.
//
// Owns a module-scoped mock of child_process (process-global; per-file
// isolation keeps it from leaking into the rest of the suite).

import { describe, expect, test, mock } from 'bun:test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

function emfileChild() {
  const child = new EventEmitter() as EventEmitter & { stdout?: unknown; stderr?: unknown; pid?: number }
  child.stdout = undefined
  child.stderr = undefined
  queueMicrotask(() => {
    const err = Object.assign(new Error("EMFILE: too many open files, posix_spawn 'tar'"), { code: 'EMFILE' })
    child.emit('error', err)
  })
  return child
}

const fakeChildProcess = () => ({ spawn: (..._args: unknown[]) => emfileChild() })
mock.module('node:child_process', fakeChildProcess)
mock.module('child_process', fakeChildProcess)

const { packRepoArchive, getHeadSha } = await import('../repo-store')

function repoDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shogo-repo-emfile-'))
  mkdirSync(join(dir, '.git'))
  return dir
}

describe('repo-store spawn helpers when stdio pipes cannot be created (EMFILE)', () => {
  test('packRepoArchive rejects with the spawn error instead of a TypeError', async () => {
    const dir = repoDir()
    await expect(packRepoArchive(dir, join(dir, 'out.tar.gz'))).rejects.toThrow('EMFILE')
  })

  test('getHeadSha resolves null', async () => {
    expect(await getHeadSha(repoDir())).toBeNull()
  })
})
