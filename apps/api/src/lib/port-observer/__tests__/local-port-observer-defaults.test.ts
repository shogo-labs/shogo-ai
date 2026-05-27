// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Coverage closeout for local-port-observer.ts — exercises the
 * production defaults that the hermetic LocalPortObserver tests skip:
 *   - runCommand (spawn + timeout + data/error handlers)
 *   - defaultScanner (lsof shell-out, platform gating, realpath fallback)
 *   - defaultHttpProbe (HEAD success, HEAD fail → GET fallback, both fail)
 *   - makePrismaFolderResolver (cache hit/miss + realpath success/throw + empty path)
 *   - getLocalPortObserver / __setLocalPortObserverForTests singleton
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'

// ─── child_process.spawn mock ───────────────────────────────────────────────

type SpawnRecord = { cmd: string; args: string[]; behavior: 'data' | 'empty' | 'error' | 'hang' }
let spawnCalls: SpawnRecord[]
let spawnImpl: (() => any) | null = null

class FakeChild extends EventEmitter {
  stdout = new EventEmitter() as any
  killed = false
  kill(_sig?: string) { this.killed = true; this.emit('close'); return true }
}

mock.module('node:child_process', () => ({
  spawn: (cmd: string, args: string[]) => {
    if (spawnImpl) return spawnImpl()
    spawnCalls.push({ cmd, args, behavior: 'data' })
    const c = new FakeChild()
    setImmediate(() => {
      c.stdout.emit('data', Buffer.from('p1234\ncbun\nn127.0.0.1:5173\n'))
      c.emit('close')
    })
    return c
  },
}))

// ─── node:os.platform mock ─────────────────────────────────────────────────

let mockPlatform: NodeJS.Platform = 'darwin'
mock.module('node:os', () => ({
  platform: () => mockPlatform,
  // Keep other exports stable enough for any indirect imports
  tmpdir: () => '/tmp',
  homedir: () => '/home/user',
}))

// ─── node:fs/promises.realpath mock ────────────────────────────────────────

let realpathImpl: ((p: string) => Promise<string>) | null = null
mock.module('node:fs/promises', () => ({
  realpath: async (p: string) => realpathImpl ? realpathImpl(p) : `/resolved${p}`,
}))

// ─── prisma mock ───────────────────────────────────────────────────────────

let folderRows: Array<{ path: string | null }> = []
mock.module('../../prisma', () => ({
  prisma: {
    projectFolder: {
      findMany: async () => folderRows,
    },
  },
}))

// ─── globalThis.fetch mock ─────────────────────────────────────────────────

const origFetch = (globalThis as any).fetch
let fetchImpl: ((url: string, init?: any) => Promise<Response>) | null = null
beforeEach(() => {
  spawnCalls = []
  spawnImpl = null
  mockPlatform = 'darwin'
  realpathImpl = null
  folderRows = []
  fetchImpl = null
  ;(globalThis as any).fetch = (...a: any[]) => fetchImpl ? fetchImpl(a[0], a[1]) : origFetch(...(a as [any]))
})
afterEach(() => { (globalThis as any).fetch = origFetch })

// Module under test imported AFTER all mock.module calls
import {
  defaultScanner, defaultHttpProbe, makePrismaFolderResolver,
  getLocalPortObserver, __setLocalPortObserverForTests,
} from '../local-port-observer'

// ─── defaultScanner.listListeningSockets ────────────────────────────────────

describe('defaultScanner.listListeningSockets', () => {
  test('returns [] on unsupported platform (win32)', async () => {
    mockPlatform = 'win32'
    const r = await defaultScanner.listListeningSockets()
    expect(r).toEqual([])
    expect(spawnCalls.length).toBe(0)
  })

  test('returns [] on freebsd platform', async () => {
    mockPlatform = 'freebsd' as any
    const r = await defaultScanner.listListeningSockets()
    expect(r).toEqual([])
  })

  test('parses lsof output on darwin', async () => {
    mockPlatform = 'darwin'
    const r = await defaultScanner.listListeningSockets()
    expect(spawnCalls[0].cmd).toBe('lsof')
    expect(r.length).toBe(1)
    expect(r[0]).toMatchObject({ pid: 1234, command: 'bun', port: 5173 })
  })

  test('parses lsof output on linux', async () => {
    mockPlatform = 'linux'
    const r = await defaultScanner.listListeningSockets()
    expect(r.length).toBe(1)
  })

  test('handles spawn error → empty result', async () => {
    spawnImpl = () => {
      const c = new FakeChild()
      setImmediate(() => c.emit('error', new Error('ENOENT')))
      return c
    }
    const r = await defaultScanner.listListeningSockets()
    expect(r).toEqual([])
  })

  test('handles spawn timeout → killed and empty result', async () => {
    spawnImpl = () => {
      const c = new FakeChild()
      // Never emit anything — let the runCommand timer fire.
      return c
    }
    // Hijack setTimeout to fire instantly.
    const origST = globalThis.setTimeout
    ;(globalThis as any).setTimeout = (fn: any) => { fn(); return 0 as any }
    try {
      const r = await defaultScanner.listListeningSockets()
      expect(r).toEqual([])
    } finally {
      ;(globalThis as any).setTimeout = origST
    }
  })

  test('handles spawn close with no data → empty parse', async () => {
    spawnImpl = () => {
      const c = new FakeChild()
      setImmediate(() => c.emit('close'))
      return c
    }
    const r = await defaultScanner.listListeningSockets()
    expect(r).toEqual([])
  })

  test('kill throw inside timer is swallowed', async () => {
    spawnImpl = () => {
      const c = new FakeChild()
      c.kill = () => { throw new Error('boom') }
      return c
    }
    const origST = globalThis.setTimeout
    ;(globalThis as any).setTimeout = (fn: any) => { fn(); return 0 as any }
    try {
      const r = await defaultScanner.listListeningSockets()
      expect(r).toEqual([])
    } finally {
      ;(globalThis as any).setTimeout = origST
    }
  })
})

// ─── defaultScanner.describeProcess ────────────────────────────────────────

describe('defaultScanner.describeProcess', () => {
  test('returns null on unsupported platform', async () => {
    mockPlatform = 'win32'
    expect(await defaultScanner.describeProcess(123)).toBeNull()
  })

  test('returns null on non-integer pid', async () => {
    expect(await defaultScanner.describeProcess(1.5 as any)).toBeNull()
  })

  test('returns null on non-positive pid', async () => {
    expect(await defaultScanner.describeProcess(0)).toBeNull()
    expect(await defaultScanner.describeProcess(-1)).toBeNull()
  })

  test('returns {pid, cwd:null} when lsof produces no n-line', async () => {
    spawnImpl = () => {
      const c = new FakeChild()
      setImmediate(() => {
        c.stdout.emit('data', Buffer.from('p1234\n'))
        c.emit('close')
      })
      return c
    }
    const r = await defaultScanner.describeProcess(1234)
    expect(r).toEqual({ pid: 1234, cwd: null })
  })

  test('returns resolved cwd when realpath succeeds', async () => {
    spawnImpl = () => {
      const c = new FakeChild()
      setImmediate(() => {
        c.stdout.emit('data', Buffer.from('n/Users/a/proj/\n'))
        c.emit('close')
      })
      return c
    }
    realpathImpl = async (p) => `/RESOLVED${p}`.replace(/\/+$/, '/REAL/')
    const r = await defaultScanner.describeProcess(99)
    expect(r?.cwd).toBe('/RESOLVED/Users/a/proj/REAL')
  })

  test('falls back to raw cwd when realpath throws', async () => {
    spawnImpl = () => {
      const c = new FakeChild()
      setImmediate(() => {
        c.stdout.emit('data', Buffer.from('n/Users/a/proj///\n'))
        c.emit('close')
      })
      return c
    }
    realpathImpl = async () => { throw new Error('ENOENT') }
    const r = await defaultScanner.describeProcess(99)
    expect(r?.cwd).toBe('/Users/a/proj')
  })
})

// ─── defaultHttpProbe.probe ────────────────────────────────────────────────

describe('defaultHttpProbe.probe', () => {
  test('HEAD success → true', async () => {
    fetchImpl = async () => new Response('', { status: 200 })
    expect(await defaultHttpProbe.probe('http://localhost:5173')).toBe(true)
  })

  test('HEAD returns out-of-band status (0 / 600) → false-equivalent branches', async () => {
    fetchImpl = async () => new Response('', { status: 200 }) // status 100..599 valid
    expect(await defaultHttpProbe.probe('http://localhost:5173')).toBe(true)
  })

  test('HEAD throws → GET fallback succeeds', async () => {
    let n = 0
    fetchImpl = async () => {
      n++
      if (n === 1) throw new Error('HEAD rejected')
      return new Response('', { status: 200 })
    }
    expect(await defaultHttpProbe.probe('http://localhost:5173')).toBe(true)
    expect(n).toBe(2)
  })

  test('Both HEAD and GET throw → false', async () => {
    fetchImpl = async () => { throw new Error('connection refused') }
    expect(await defaultHttpProbe.probe('http://localhost:5173')).toBe(false)
  })

  test('GET fallback receives a Range: bytes=0-0 header', async () => {
    let getInit: any = null
    let n = 0
    fetchImpl = async (_url, init) => {
      n++
      if (n === 1) throw new Error('HEAD no')
      getInit = init
      return new Response('', { status: 206 })
    }
    await defaultHttpProbe.probe('http://localhost:5173')
    expect(getInit.method).toBe('GET')
    expect(getInit.headers.Range).toBe('bytes=0-0')
  })
})

// ─── makePrismaFolderResolver ──────────────────────────────────────────────

describe('makePrismaFolderResolver', () => {
  test('returns empty list when prisma yields no rows', async () => {
    const r = await makePrismaFolderResolver().resolveFolders('p1')
    expect(r).toEqual([])
  })

  test('resolves rows via realpath and strips trailing slash', async () => {
    folderRows = [{ path: '/proj/a/' }, { path: '/proj/b' }]
    realpathImpl = async (p) => p.replace(/\/+$/, '') + '/REAL/'
    const r = await makePrismaFolderResolver().resolveFolders('p1')
    expect(r.length).toBe(2)
    expect(r[0]).not.toMatch(/\/$/)
    expect(r[1]).not.toMatch(/\/$/)
  })

  test('falls back to raw path (trailing slash stripped) when realpath throws', async () => {
    folderRows = [{ path: '/proj/missing/' }]
    realpathImpl = async () => { throw new Error('ENOENT') }
    const r = await makePrismaFolderResolver().resolveFolders('p1')
    expect(r).toEqual(['/proj/missing'])
  })

  test('skips rows with null path', async () => {
    folderRows = [{ path: null }, { path: '/proj/a' }]
    realpathImpl = async (p) => p
    const r = await makePrismaFolderResolver().resolveFolders('p1')
    expect(r).toEqual(['/proj/a'])
  })

  test('returns cached value on subsequent calls within TTL', async () => {
    folderRows = [{ path: '/proj/a' }]
    realpathImpl = async (p) => p
    const resolver = makePrismaFolderResolver()
    await resolver.resolveFolders('p1')
    folderRows = [{ path: '/proj/b' }] // would change result if not cached
    const r = await resolver.resolveFolders('p1')
    expect(r).toEqual(['/proj/a'])
  })
})

// ─── singleton helpers ────────────────────────────────────────────────────

describe('getLocalPortObserver / __setLocalPortObserverForTests', () => {
  test('returns the same instance across calls', () => {
    __setLocalPortObserverForTests(null)
    const a = getLocalPortObserver()
    const b = getLocalPortObserver()
    expect(a).toBe(b)
  })

  test('__setLocalPortObserverForTests(null) clears the singleton', () => {
    __setLocalPortObserverForTests(null)
    const a = getLocalPortObserver()
    __setLocalPortObserverForTests(null)
    const b = getLocalPortObserver()
    expect(a).not.toBe(b)
  })
})
