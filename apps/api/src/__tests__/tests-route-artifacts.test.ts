// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Coverage extras for src/routes/tests.ts targeting:
//   - findTestResultAttachments (lines 60-89): scans test-results/ recursively
//     for .png screenshots, trace.zip, and .webm videos. Verifies that the
//     artifact list is appended to the streaming response on test exit, and
//     that the readdirSync catch swallows errors mid-walk.
//   - run handler exit-code branch with non-zero code surfaces artifacts too.

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'events'

interface FsEntry { type: 'file' | 'dir'; content?: string; readdirThrows?: boolean }
const fsState = new Map<string, FsEntry>()
function setFile(p: string, c = '') {
  fsState.set(p, { type: 'file', content: c })
  const parts = p.split('/')
  for (let i = 1; i < parts.length; i++) {
    const d = parts.slice(0, i).join('/')
    if (d && !fsState.has(d)) fsState.set(d, { type: 'dir' })
  }
}
function setDir(p: string, opts: { readdirThrows?: boolean } = {}) {
  fsState.set(p, { type: 'dir', readdirThrows: opts.readdirThrows })
  const parts = p.split('/')
  for (let i = 1; i < parts.length; i++) {
    const d = parts.slice(0, i).join('/')
    if (d && !fsState.has(d)) fsState.set(d, { type: 'dir' })
  }
}

mock.module('fs', () => ({
  existsSync: (p: string) => fsState.has(p),
  readdirSync: (dir: string, _opts?: any) => {
    const e = fsState.get(dir)
    if (e?.readdirThrows) throw new Error('EACCES')
    const prefix = dir.endsWith('/') ? dir : dir + '/'
    const entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = []
    for (const [p, ent] of fsState) {
      if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) {
        const name = p.slice(prefix.length)
        if (name) {
          entries.push({
            name,
            isDirectory: () => ent.type === 'dir',
            isFile: () => ent.type === 'file',
          })
        }
      }
    }
    return entries
  },
  statSync: (p: string) => {
    const e = fsState.get(p)
    if (!e) throw new Error(`ENOENT: ${p}`)
    return { isDirectory: () => e.type === 'dir', isFile: () => e.type === 'file', size: e.content?.length ?? 0 }
  },
  readFileSync: (p: string, _enc?: any) => {
    const e = fsState.get(p)
    if (!e || e.type !== 'file') throw new Error(`ENOENT: ${p}`)
    return e.content!
  },
}))

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  exitCode: number | null = null
  kill = mock(() => true)
}
let lastSpawn: FakeChild | null = null
let nextSpawnBehavior: (c: FakeChild) => void = (c) => {
  c.exitCode = 0
  setTimeout(() => c.emit('close', 0), 0)
}
const spawnSpy = mock((..._args: any[]) => {
  const c = new FakeChild()
  lastSpawn = c
  queueMicrotask(() => nextSpawnBehavior(c))
  return c as any
})
const execSyncSpy = mock((_cmd: string, _opts: any) => Buffer.from(''))
mock.module('child_process', () => ({ spawn: spawnSpy, execSync: execSyncSpy }))

const { testsRoutes } = await import('../routes/tests')
const router = testsRoutes({ workspacesDir: '/ws' })

beforeEach(() => {
  fsState.clear()
  spawnSpy.mockClear()
  execSyncSpy.mockClear()
  execSyncSpy.mockImplementation(() => Buffer.from(''))
  lastSpawn = null
  nextSpawnBehavior = (c) => {
    c.exitCode = 0
    setTimeout(() => c.emit('close', 0), 0)
  }
})

afterAll(() => mock.restore())

function run(pid: string, body: any = {}) {
  return router.request(`/projects/${pid}/tests/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function readStream(res: Response): Promise<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let out = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value)
  }
  return out
}

// ─── Artifact streaming ────────────────────────────────────────────────

describe('test-result artifact streaming', () => {
  test('appends an "Test Artifacts" section listing .png screenshots', async () => {
    setDir('/ws/p_art_png')
    setDir('/ws/p_art_png/node_modules')
    setDir('/ws/p_art_png/test-results')
    setDir('/ws/p_art_png/test-results/some-test')
    setFile('/ws/p_art_png/test-results/some-test/screenshot-1.png', '')
    setFile('/ws/p_art_png/test-results/some-test/screenshot-2.png', '')

    const res = await run('p_art_png')
    const out = await readStream(res)

    expect(out).toContain('--- Test Artifacts ---')
    expect(out).toContain('test-results/some-test/screenshot-1.png')
    expect(out).toContain('test-results/some-test/screenshot-2.png')
    expect(out).toContain('[Process exited with code 0]')
  })

  test('lists trace.zip files', async () => {
    setDir('/ws/p_art_trace')
    setDir('/ws/p_art_trace/node_modules')
    setDir('/ws/p_art_trace/test-results')
    setDir('/ws/p_art_trace/test-results/failed-test')
    setFile('/ws/p_art_trace/test-results/failed-test/trace.zip', '')

    const out = await readStream(await run('p_art_trace'))
    expect(out).toContain('--- Test Artifacts ---')
    expect(out).toContain('test-results/failed-test/trace.zip')
  })

  test('lists .webm video files', async () => {
    setDir('/ws/p_art_video')
    setDir('/ws/p_art_video/node_modules')
    setDir('/ws/p_art_video/test-results')
    setDir('/ws/p_art_video/test-results/recorded-test')
    setFile('/ws/p_art_video/test-results/recorded-test/video.webm', '')

    const out = await readStream(await run('p_art_video'))
    expect(out).toContain('--- Test Artifacts ---')
    expect(out).toContain('test-results/recorded-test/video.webm')
  })

  test('lists screenshots + traces + videos all together', async () => {
    setDir('/ws/p_art_all')
    setDir('/ws/p_art_all/node_modules')
    setDir('/ws/p_art_all/test-results')
    setDir('/ws/p_art_all/test-results/t1')
    setFile('/ws/p_art_all/test-results/t1/shot.png', '')
    setFile('/ws/p_art_all/test-results/t1/trace.zip', '')
    setFile('/ws/p_art_all/test-results/t1/recording.webm', '')
    setFile('/ws/p_art_all/test-results/t1/log.txt', '') // ignored

    const out = await readStream(await run('p_art_all'))
    expect(out).toContain('shot.png')
    expect(out).toContain('trace.zip')
    expect(out).toContain('recording.webm')
    // log.txt is NOT a recognized artifact type — must NOT appear.
    expect(out).not.toContain('log.txt')
  })

  test('no test-results dir → no artifact section (just exit code)', async () => {
    setDir('/ws/p_no_art')
    setDir('/ws/p_no_art/node_modules')

    const out = await readStream(await run('p_no_art'))
    expect(out).not.toContain('--- Test Artifacts ---')
    expect(out).toContain('[Process exited with code 0]')
  })

  test('empty test-results dir → no artifact section', async () => {
    setDir('/ws/p_empty_art')
    setDir('/ws/p_empty_art/node_modules')
    setDir('/ws/p_empty_art/test-results')

    const out = await readStream(await run('p_empty_art'))
    expect(out).not.toContain('--- Test Artifacts ---')
    expect(out).toContain('[Process exited with code 0]')
  })

  test('readdirSync error inside test-results walk is swallowed (line 87-88 catch)', async () => {
    setDir('/ws/p_walk_err')
    setDir('/ws/p_walk_err/node_modules')
    setDir('/ws/p_walk_err/test-results', { readdirThrows: true })

    const out = await readStream(await run('p_walk_err'))
    // No artifacts found (walk caught the error), but the stream still
    // completes with the exit-code marker.
    expect(out).not.toContain('--- Test Artifacts ---')
    expect(out).toContain('[Process exited with code 0]')
  })

  test('readdirSync error on a nested subdirectory does not break the walk for siblings', async () => {
    setDir('/ws/p_nested_err')
    setDir('/ws/p_nested_err/node_modules')
    setDir('/ws/p_nested_err/test-results')
    setDir('/ws/p_nested_err/test-results/broken', { readdirThrows: true })
    setDir('/ws/p_nested_err/test-results/ok')
    setFile('/ws/p_nested_err/test-results/ok/recovered.png', '')

    const out = await readStream(await run('p_nested_err'))
    // We still surface the "ok" subdir's screenshot even though "broken" threw.
    expect(out).toContain('--- Test Artifacts ---')
    expect(out).toContain('test-results/ok/recovered.png')
  })

  test('artifacts are still surfaced even when test exit code is non-zero', async () => {
    setDir('/ws/p_failed_art')
    setDir('/ws/p_failed_art/node_modules')
    setDir('/ws/p_failed_art/test-results')
    setDir('/ws/p_failed_art/test-results/failed-spec')
    setFile('/ws/p_failed_art/test-results/failed-spec/failure.png', '')
    setFile('/ws/p_failed_art/test-results/failed-spec/trace.zip', '')

    nextSpawnBehavior = (c) => {
      c.stderr.emit('data', Buffer.from('FAIL: spec\n'))
      c.exitCode = 1
      queueMicrotask(() => c.emit('close', 1))
    }

    const out = await readStream(await run('p_failed_art'))
    expect(out).toContain('FAIL: spec')
    expect(out).toContain('--- Test Artifacts ---')
    expect(out).toContain('failure.png')
    expect(out).toContain('trace.zip')
    expect(out).toContain('[Process exited with code 1]')
  })
})
