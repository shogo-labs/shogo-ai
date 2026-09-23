// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * BrowserPool: one shared Chromium, a capped number of BrowserContexts with a
 * FIFO wait queue, idle close, and relaunch after a crash. Plus the orphan
 * Chromium reaper's process selection and the per-session cleanup registry.
 */

import { describe, test, expect } from 'bun:test'
import {
  BrowserPool,
  BrowserPoolTimeoutError,
  localChromiumArgs,
  parseProcStat,
  reapOrphanChromium,
  registerBrowserSessionCleanup,
  releaseSessionBrowsers,
  selectOrphanChromiumPids,
  type PoolBrowser,
  type PoolContext,
  type ProcEntry,
} from '../browser-pool'

class FakeContext implements PoolContext {
  closed = false
  async newPage() { return { close: async () => {} } }
  async close() { this.closed = true }
}

class FakeBrowser implements PoolBrowser {
  connected = true
  closeCalls = 0
  contexts: FakeContext[] = []
  private listeners: Array<() => void> = []
  async newContext() {
    if (!this.connected) throw new Error('Target page, context or browser has been closed')
    const c = new FakeContext()
    this.contexts.push(c)
    return c
  }
  async close() {
    this.closeCalls++
    this.crash()
  }
  isConnected() { return this.connected }
  on(_event: 'disconnected', listener: () => void) { this.listeners.push(listener) }
  crash() {
    if (!this.connected) return
    this.connected = false
    for (const l of this.listeners) l()
  }
}

function makePool(opts?: { maxContexts?: number; idleCloseMs?: number; acquireTimeoutMs?: number }) {
  const launched: FakeBrowser[] = []
  const pool = new BrowserPool({
    launch: async () => {
      const b = new FakeBrowser()
      launched.push(b)
      return { browser: b, pid: 1000 + launched.length }
    },
    maxContexts: opts?.maxContexts ?? 2,
    idleCloseMs: opts?.idleCloseMs ?? 60_000,
    acquireTimeoutMs: opts?.acquireTimeoutMs ?? 5_000,
  })
  return { pool, launched }
}

const tick = () => new Promise(r => setTimeout(r, 0))
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('BrowserPool', () => {
  test('shares one browser across contexts and launches only once concurrently', async () => {
    const { pool, launched } = makePool()
    const [a, b] = await Promise.all([pool.acquire(), pool.acquire()])
    expect(launched.length).toBe(1)
    expect(launched[0].contexts.length).toBe(2)
    expect(a.context).not.toBe(b.context)
    expect(pool.activeCount).toBe(2)
    expect(pool.browserPid).toBe(1001)
    await pool.shutdown()
  })

  test('caps concurrent contexts and queues extra acquirers FIFO', async () => {
    const { pool } = makePool({ maxContexts: 2 })
    const a = await pool.acquire()
    const b = await pool.acquire()
    const order: string[] = []
    const c = pool.acquire().then(l => { order.push('c'); return l })
    const d = pool.acquire().then(l => { order.push('d'); return l })
    await tick()
    expect(pool.queuedCount).toBe(2)
    expect(order).toEqual([])

    await a.release()
    const lc = await c
    expect(order).toEqual(['c'])
    expect(pool.activeCount).toBe(2)
    expect(pool.queuedCount).toBe(1)

    await b.release()
    const ld = await d
    expect(order).toEqual(['c', 'd'])

    await lc.release()
    await ld.release()
    expect(pool.activeCount).toBe(0)
    await pool.shutdown()
  })

  test('release closes the context, frees a slot, and is idempotent', async () => {
    const { pool } = makePool({ maxContexts: 1 })
    const a = await pool.acquire()
    await a.release()
    await a.release()
    expect((a.context as FakeContext).closed).toBe(true)
    expect(pool.activeCount).toBe(0)
    const b = await pool.acquire()
    expect(pool.activeCount).toBe(1)
    await b.release()
    await pool.shutdown()
  })

  test('queued acquire times out with a clear error', async () => {
    const { pool } = makePool({ maxContexts: 1, acquireTimeoutMs: 20 })
    const a = await pool.acquire()
    const err = await pool.acquire().catch(e => e)
    expect(err).toBeInstanceOf(BrowserPoolTimeoutError)
    expect(String(err.message)).toContain('Browser busy')
    expect(pool.queuedCount).toBe(0)
    expect(pool.activeCount).toBe(1)
    await a.release()
    expect(pool.activeCount).toBe(0)
    await pool.shutdown()
  })

  test('closes the shared browser after the idle timeout once all contexts are released', async () => {
    const { pool, launched } = makePool({ idleCloseMs: 20 })
    const a = await pool.acquire()
    const b = await pool.acquire()
    await a.release()
    await sleep(40)
    expect(launched[0].closeCalls).toBe(0)
    await b.release()
    expect(pool.hasBrowser).toBe(true)
    await sleep(40)
    expect(launched[0].closeCalls).toBe(1)
    expect(pool.hasBrowser).toBe(false)
    expect(pool.browserPid).toBeNull()

    const c = await pool.acquire()
    expect(launched.length).toBe(2)
    await c.release()
    await pool.shutdown()
  })

  test('acquire before the idle timeout cancels the close', async () => {
    const { pool, launched } = makePool({ idleCloseMs: 30 })
    const a = await pool.acquire()
    await a.release()
    await sleep(10)
    const b = await pool.acquire()
    await sleep(50)
    expect(launched[0].closeCalls).toBe(0)
    expect(launched.length).toBe(1)
    await b.release()
    await pool.shutdown()
  })

  test('browser crash frees slots, wakes waiters, and relaunches on next acquire', async () => {
    const { pool, launched } = makePool({ maxContexts: 1 })
    const a = await pool.acquire()
    const waiting = pool.acquire()
    await tick()
    expect(pool.queuedCount).toBe(1)

    launched[0].crash()
    const b = await waiting
    expect(launched.length).toBe(2)
    expect(pool.browserPid).toBe(1002)
    expect(pool.activeCount).toBe(1)

    // A late release of the dead lease must not free the new holder's slot.
    await a.release()
    expect(pool.activeCount).toBe(1)
    await b.release()
    expect(pool.activeCount).toBe(0)
    await pool.shutdown()
  })

  test('launch failure frees the slot and the next acquire retries', async () => {
    let attempts = 0
    const pool = new BrowserPool({
      launch: async () => {
        attempts++
        if (attempts === 1) throw new Error('no chromium')
        return { browser: new FakeBrowser(), pid: 7 }
      },
      maxContexts: 1,
    })
    await expect(pool.acquire()).rejects.toThrow('no chromium')
    expect(pool.activeCount).toBe(0)
    const a = await pool.acquire()
    expect(attempts).toBe(2)
    await a.release()
    await pool.shutdown()
  })
})

describe('isDeadBrowserError', () => {
  test('matches closed/crashed page errors but not ordinary action failures', async () => {
    const { isDeadBrowserError } = await import('../gateway-tools')
    expect(isDeadBrowserError('page.goto: Target page, context or browser has been closed')).toBe(true)
    expect(isDeadBrowserError('Target closed')).toBe(true)
    expect(isDeadBrowserError('browser.newContext: Browser has been closed')).toBe(true)
    expect(isDeadBrowserError('page.evaluate: Page crashed')).toBe(true)
    expect(isDeadBrowserError('locator.click: Timeout 10000ms exceeded')).toBe(false)
    expect(isDeadBrowserError('Execution context was destroyed, most likely because of a navigation')).toBe(false)
    expect(isDeadBrowserError(undefined)).toBe(false)
  })
})

describe('session cleanup registry', () => {
  test('releaseSessionBrowsers runs registered cleanups once; unregister removes them', async () => {
    const calls: string[] = []
    registerBrowserSessionCleanup('s1', () => { calls.push('a') })
    const unregister = registerBrowserSessionCleanup('s1', () => { calls.push('b') })
    registerBrowserSessionCleanup('s2', () => { calls.push('other') })
    unregister()
    await releaseSessionBrowsers('s1')
    await releaseSessionBrowsers('s1')
    expect(calls).toEqual(['a'])
    await releaseSessionBrowsers('s2')
    expect(calls).toEqual(['a', 'other'])
  })
})

describe('localChromiumArgs', () => {
  test('always includes memory-saving flags; sandbox flags only in containers', () => {
    expect(localChromiumArgs({})).toEqual(['--disable-dev-shm-usage', '--disable-gpu', '--renderer-process-limit=2'])
    const inContainer = localChromiumArgs({ CONTAINER: '1' })
    expect(inContainer.slice(0, 2)).toEqual(['--no-sandbox', '--disable-setuid-sandbox'])
    expect(inContainer).toContain('--renderer-process-limit=2')
  })
})

describe('orphan Chromium reaper', () => {
  const SELF = 50
  // Process tree:
  //   1 init
  //   ├─ 50 bun (runtime)
  //   │   ├─ 100 chrome (shared browser) ─ 101 chrome (zygote) ─ 102 chrome (renderer)
  //   │   └─ 200 chrome (leaked launch)  ─ 201 chrome
  //   ├─ 300 chrome (orphan from a dead runtime) ─ 301 chrome ─ 302 chrome
  //   └─ 400 node (user's playwright test) ─ 401 chrome ─ 402 chrome
  //   └─ 500 headless_shell (orphan)
  //   └─ 600 sshd
  const entries: ProcEntry[] = [
    { pid: 1, ppid: 0, comm: 'init' },
    { pid: SELF, ppid: 1, comm: 'bun' },
    { pid: 100, ppid: SELF, comm: 'chrome' },
    { pid: 101, ppid: 100, comm: 'chrome' },
    { pid: 102, ppid: 101, comm: 'chrome' },
    { pid: 200, ppid: SELF, comm: 'chrome' },
    { pid: 201, ppid: 200, comm: 'chrome' },
    { pid: 300, ppid: 1, comm: 'chromium' },
    { pid: 301, ppid: 300, comm: 'chromium' },
    { pid: 302, ppid: 301, comm: 'chromium' },
    { pid: 400, ppid: 1, comm: 'node' },
    { pid: 401, ppid: 400, comm: 'chrome' },
    { pid: 402, ppid: 401, comm: 'chrome' },
    { pid: 500, ppid: 1, comm: 'headless_shell' },
    { pid: 600, ppid: 1, comm: 'sshd' },
  ]

  test('selects orphans and leaked children, sparing the shared tree and foreign parents', () => {
    expect(selectOrphanChromiumPids(entries, { selfPid: SELF, sharedPid: 100 }))
      .toEqual([200, 201, 300, 301, 302, 500])
  })

  test('with no shared browser every runtime-owned chromium is a leak', () => {
    expect(selectOrphanChromiumPids(entries, { selfPid: SELF, sharedPid: null }))
      .toEqual([100, 101, 102, 200, 201, 300, 301, 302, 500])
  })

  test('reapOrphanChromium kills selected pids on linux, no-op elsewhere', () => {
    const killed: number[] = []
    const kill = (pid: number) => { killed.push(pid) }
    const readProc = () => entries
    expect(reapOrphanChromium({ platform: 'darwin', readProc, kill, selfPid: SELF, pool: null })).toEqual([])
    expect(killed).toEqual([])
    const result = reapOrphanChromium({ platform: 'linux', readProc, kill, selfPid: SELF, pool: null })
    expect(result).toEqual([100, 101, 102, 200, 201, 300, 301, 302, 500])
    expect(killed).toEqual(result)
  })

  test('skips reaping while the shared browser pid is unknown', async () => {
    const pool = new BrowserPool({ launch: async () => ({ browser: new FakeBrowser(), pid: null }) })
    const lease = await pool.acquire()
    const killed: number[] = []
    reapOrphanChromium({ platform: 'linux', readProc: () => entries, kill: p => { killed.push(p) }, selfPid: SELF, pool })
    expect(killed).toEqual([])
    await lease.release()
    await pool.shutdown()
  })

  test('parseProcStat handles comm with spaces and parens', () => {
    expect(parseProcStat('123 (chrome) S 45 123 123 0 -1')).toEqual({ pid: 123, ppid: 45, comm: 'chrome' })
    expect(parseProcStat('9 (weird (name) x) R 1 9 9')).toEqual({ pid: 9, ppid: 1, comm: 'weird (name) x' })
    expect(parseProcStat('garbage')).toBeNull()
  })
})
