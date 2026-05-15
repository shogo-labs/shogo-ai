// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `src/routes/tests.ts`.
 *
 * Endpoints:
 *   - GET  /projects/:id/tests/list  — discover test files, parse describe/test/it
 *   - POST /projects/:id/tests/run   — streams test runner output (mocked spawn)
 *
 * Covers:
 *   - parseTestCases (indirect): describe nesting, test/it/test.describe, line numbers
 *   - findTestFiles (indirect): scans tests/, __tests__/, e2e/, spec/, root
 *   - de-duplication across multiple test directories
 *   - hasTests + totalTests aggregates
 *   - "not initialized" when project dir missing
 *   - run: 404 when project missing, install_failed when execSync throws,
 *     streaming response shape (Content-Type, body content)
 *   - run: command construction honours file, line, testName, headed, reporter
 *   - run: skipped install when node_modules already present
 */

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'events'

// ─── fs mock ──────────────────────────────────────────────────────────

interface FsEntry { type: 'file' | 'dir'; content?: string }
const fsState = new Map<string, FsEntry>()
function setFile(p: string, c: string) {
  fsState.set(p, { type: 'file', content: c })
  const parts = p.split('/')
  for (let i = 1; i < parts.length; i++) {
    const d = parts.slice(0, i).join('/')
    if (d && !fsState.has(d)) fsState.set(d, { type: 'dir' })
  }
}
function setDir(p: string) { fsState.set(p, { type: 'dir' }) }

mock.module('fs', () => ({
  existsSync: (p: string) => fsState.has(p),
  readdirSync: (dir: string, _opts?: any) => {
    const prefix = dir.endsWith('/') ? dir : dir + '/'
    const entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = []
    for (const [p, e] of fsState) {
      if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) {
        const name = p.slice(prefix.length)
        if (name) {
          entries.push({
            name,
            isDirectory: () => e.type === 'dir',
            isFile: () => e.type === 'file',
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

// ─── child_process mock ───────────────────────────────────────────────

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  exitCode: number | null = null
  kill = mock(() => true)
}
let lastSpawn: FakeChild | null = null
let nextSpawnBehavior: (c: FakeChild) => void = () => {}
const spawnSpy = mock((..._args: any[]) => {
  const c = new FakeChild()
  lastSpawn = c
  // Apply test-supplied behavior asynchronously
  queueMicrotask(() => nextSpawnBehavior(c))
  return c as any
})

const execSyncSpy = mock((_cmd: string, _opts: any) => Buffer.from(''))

mock.module('child_process', () => ({
  spawn: spawnSpy,
  execSync: execSyncSpy,
}))

// ─── Import after mocks ──────────────────────────────────────────────

const { testsRoutes } = await import('../routes/tests')
const router = testsRoutes({ workspacesDir: '/ws' })

// ─── Helpers ──────────────────────────────────────────────────────────

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

// ═══════════════════════════════════════════════════════════════════════
// GET /projects/:id/tests/list
// ═══════════════════════════════════════════════════════════════════════

describe('GET /projects/:id/tests/list', () => {
  test('not_initialized response when project dir missing', async () => {
    const res = await router.request('/projects/p_miss/tests/list')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.files).toEqual([])
    expect(body.hasTests).toBe(false)
    expect(body.message).toMatch(/not yet initialized/)
  })

  test('finds .test.ts files in tests/ directory', async () => {
    setDir('/ws/p1')
    setDir('/ws/p1/tests')
    setFile('/ws/p1/tests/a.test.ts', `test('foo', () => {})\ntest('bar', () => {})\n`)
    const body = await (await router.request('/projects/p1/tests/list')).json()
    expect(body.hasTests).toBe(true)
    expect(body.files).toHaveLength(1)
    expect(body.files[0].path).toBe('tests/a.test.ts')
    expect(body.files[0].tests).toHaveLength(2)
    expect(body.files[0].tests[0].title).toBe('foo')
    expect(body.files[0].tests[1].title).toBe('bar')
    expect(body.totalTests).toBe(2)
  })

  test('parses describe blocks and produces full titles', async () => {
    setDir('/ws/p2')
    setDir('/ws/p2/__tests__')
    setFile(
      '/ws/p2/__tests__/api.test.ts',
      `describe('Users', () => {
  test('signs up', () => {})
})
`,
    )
    const body = await (await router.request('/projects/p2/tests/list')).json()
    expect(body.files[0].tests[0].fullTitle).toBe('Users › signs up')
  })

  test('handles `it()` and `test.describe()`', async () => {
    setDir('/ws/p3')
    setDir('/ws/p3/spec')
    setFile(
      '/ws/p3/spec/legacy.spec.ts',
      `test.describe('Group', () => {
  it('does thing', () => {})
})
`,
    )
    const body = await (await router.request('/projects/p3/tests/list')).json()
    expect(body.files[0].tests).toHaveLength(1)
    expect(body.files[0].tests[0].fullTitle).toBe('Group › does thing')
  })

  test('deduplicates files reachable from multiple test roots', async () => {
    setDir('/ws/p4')
    setDir('/ws/p4/tests')
    setDir('/ws/p4/e2e')
    setFile('/ws/p4/tests/a.test.ts', `test('a', () => {})`)
    setFile('/ws/p4/e2e/b.test.ts', `test('b', () => {})`)
    const body = await (await router.request('/projects/p4/tests/list')).json()
    expect(body.files).toHaveLength(2)
  })

  test('finds test files at project root', async () => {
    setDir('/ws/p5')
    setFile('/ws/p5/root.test.ts', `test('root', () => {})`)
    const body = await (await router.request('/projects/p5/tests/list')).json()
    expect(body.files.map((f: any) => f.path)).toContain('root.test.ts')
  })

  test('captures line numbers for each test', async () => {
    setDir('/ws/p6')
    setDir('/ws/p6/tests')
    setFile(
      '/ws/p6/tests/lined.test.ts',
      `// header
test('first', () => {})
// pad
test('second', () => {})
`,
    )
    const body = await (await router.request('/projects/p6/tests/list')).json()
    expect(body.files[0].tests[0].line).toBe(2)
    expect(body.files[0].tests[1].line).toBe(4)
  })

  test('ignores non-test source files', async () => {
    setDir('/ws/p7')
    setDir('/ws/p7/tests')
    setFile('/ws/p7/tests/helper.ts', `export const x = 1`)
    setFile('/ws/p7/tests/main.test.ts', `test('m', () => {})`)
    const body = await (await router.request('/projects/p7/tests/list')).json()
    expect(body.files).toHaveLength(1)
    expect(body.files[0].name).toBe('main.test.ts')
  })

  test('skips node_modules when scanning', async () => {
    setDir('/ws/p8')
    setDir('/ws/p8/tests')
    setDir('/ws/p8/tests/node_modules')
    setFile('/ws/p8/tests/node_modules/pkg.test.ts', `test('x', () => {})`)
    setFile('/ws/p8/tests/main.test.ts', `test('m', () => {})`)
    const body = await (await router.request('/projects/p8/tests/list')).json()
    expect(body.files).toHaveLength(1)
    expect(body.files[0].name).toBe('main.test.ts')
  })

  test('returns hasTests:false + 0 totalTests when no files', async () => {
    setDir('/ws/p9')
    const body = await (await router.request('/projects/p9/tests/list')).json()
    expect(body.hasTests).toBe(false)
    expect(body.totalTests).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// POST /projects/:id/tests/run
// ═══════════════════════════════════════════════════════════════════════

describe('POST /projects/:id/tests/run', () => {
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

  test('404 when project missing', async () => {
    const res = await run('missing')
    expect(res.status).toBe(404)
  })

  test('500 install_failed when execSync throws and no node_modules', async () => {
    setDir('/ws/p_inst_fail')
    execSyncSpy.mockImplementation(() => { throw new Error('install boom') })
    const res = await run('p_inst_fail')
    expect(res.status).toBe(500)
    expect((await res.json()).error.code).toBe('install_failed')
  })

  test('runs bun install when node_modules missing', async () => {
    setDir('/ws/p_install_ok')
    nextSpawnBehavior = (c) => { c.exitCode = 0; queueMicrotask(() => c.emit('close', 0)) }
    const res = await run('p_install_ok')
    expect(res.status).toBe(200)
    expect(execSyncSpy).toHaveBeenCalledTimes(1)
    expect(execSyncSpy.mock.calls[0][0]).toBe('bun install')
    await readStream(res)
  })

  test('skips install when node_modules already exists', async () => {
    setDir('/ws/p_no_install')
    setDir('/ws/p_no_install/node_modules')
    nextSpawnBehavior = (c) => { c.exitCode = 0; queueMicrotask(() => c.emit('close', 0)) }
    const res = await run('p_no_install')
    expect(res.status).toBe(200)
    expect(execSyncSpy).not.toHaveBeenCalled()
    await readStream(res)
  })

  test('streaming response carries Content-Type text/plain', async () => {
    setDir('/ws/p_stream')
    setDir('/ws/p_stream/node_modules')
    nextSpawnBehavior = (c) => { c.exitCode = 0; queueMicrotask(() => c.emit('close', 0)) }
    const res = await run('p_stream')
    expect(res.headers.get('content-type')).toContain('text/plain')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    await readStream(res)
  })

  test('command builds in default playwright form', async () => {
    setDir('/ws/p_cmd_default')
    setDir('/ws/p_cmd_default/node_modules')
    nextSpawnBehavior = (c) => {
      c.stdout.emit('data', Buffer.from('running...'))
      c.exitCode = 0
      queueMicrotask(() => c.emit('close', 0))
    }
    const res = await run('p_cmd_default')
    await readStream(res)
    const cmd = spawnSpy.mock.calls[0][1][1]
    expect(cmd).toContain('bunx playwright test')
    expect(cmd).toContain('--reporter=list')
  })

  test('command includes file:line when line provided', async () => {
    setDir('/ws/p_line')
    setDir('/ws/p_line/node_modules')
    nextSpawnBehavior = (c) => { c.exitCode = 0; queueMicrotask(() => c.emit('close', 0)) }
    const res = await run('p_line', { file: 'tests/a.test.ts', line: 42 })
    await readStream(res)
    const cmd = spawnSpy.mock.calls[0][1][1]
    expect(cmd).toContain('"tests/a.test.ts:42"')
  })

  test('command includes --grep when testName given and line not set', async () => {
    setDir('/ws/p_grep')
    setDir('/ws/p_grep/node_modules')
    nextSpawnBehavior = (c) => { c.exitCode = 0; queueMicrotask(() => c.emit('close', 0)) }
    const res = await run('p_grep', { testName: 'my test' })
    await readStream(res)
    const cmd = spawnSpy.mock.calls[0][1][1]
    expect(cmd).toContain('--grep "my test"')
  })

  test('testName is ignored when line is set', async () => {
    setDir('/ws/p_line_overrides')
    setDir('/ws/p_line_overrides/node_modules')
    nextSpawnBehavior = (c) => { c.exitCode = 0; queueMicrotask(() => c.emit('close', 0)) }
    const res = await run('p_line_overrides', { file: 'a.test.ts', line: 10, testName: 'name' })
    await readStream(res)
    const cmd = spawnSpy.mock.calls[0][1][1]
    expect(cmd).not.toContain('--grep')
  })

  test('testName quotes are escaped', async () => {
    setDir('/ws/p_quote')
    setDir('/ws/p_quote/node_modules')
    nextSpawnBehavior = (c) => { c.exitCode = 0; queueMicrotask(() => c.emit('close', 0)) }
    const res = await run('p_quote', { testName: 'has "quote"' })
    await readStream(res)
    const cmd = spawnSpy.mock.calls[0][1][1]
    expect(cmd).toContain('\\"quote\\"')
  })

  test('reporter override flows into command', async () => {
    setDir('/ws/p_reporter')
    setDir('/ws/p_reporter/node_modules')
    nextSpawnBehavior = (c) => { c.exitCode = 0; queueMicrotask(() => c.emit('close', 0)) }
    const res = await run('p_reporter', { reporter: 'json' })
    await readStream(res)
    expect(spawnSpy.mock.calls[0][1][1]).toContain('--reporter=json')
  })

  test('--headed flag appears when headed:true', async () => {
    setDir('/ws/p_headed')
    setDir('/ws/p_headed/node_modules')
    nextSpawnBehavior = (c) => { c.exitCode = 0; queueMicrotask(() => c.emit('close', 0)) }
    const res = await run('p_headed', { headed: true })
    await readStream(res)
    expect(spawnSpy.mock.calls[0][1][1]).toContain('--headed')
  })

  test('streams stdout + exit code', async () => {
    setDir('/ws/p_stream2')
    setDir('/ws/p_stream2/node_modules')
    nextSpawnBehavior = (c) => {
      c.stdout.emit('data', Buffer.from('passed: 5\n'))
      c.exitCode = 0
      queueMicrotask(() => c.emit('close', 0))
    }
    const res = await run('p_stream2')
    const out = await readStream(res)
    expect(out).toContain('passed: 5')
    expect(out).toContain('[Process exited with code 0]')
  })

  test('streams stderr', async () => {
    setDir('/ws/p_stderr')
    setDir('/ws/p_stderr/node_modules')
    nextSpawnBehavior = (c) => {
      c.stderr.emit('data', Buffer.from('warning: deprecated\n'))
      c.exitCode = 1
      queueMicrotask(() => c.emit('close', 1))
    }
    const res = await run('p_stderr')
    const out = await readStream(res)
    expect(out).toContain('warning: deprecated')
    expect(out).toContain('[Process exited with code 1]')
  })

  test('handles malformed JSON body silently (uses defaults)', async () => {
    setDir('/ws/p_badjson')
    setDir('/ws/p_badjson/node_modules')
    nextSpawnBehavior = (c) => { c.exitCode = 0; queueMicrotask(() => c.emit('close', 0)) }
    const res = await router.request('/projects/p_badjson/tests/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(200)
    await readStream(res)
  })

  test('child error event emits error line in stream', async () => {
    setDir('/ws/p_err')
    setDir('/ws/p_err/node_modules')
    nextSpawnBehavior = (c) => {
      queueMicrotask(() => c.emit('error', new Error('spawn failed')))
    }
    const res = await run('p_err')
    const out = await readStream(res)
    expect(out).toContain('spawn failed')
  })
})
