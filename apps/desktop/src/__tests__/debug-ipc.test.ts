// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for debug-ipc handlers.
 *
 * We don't load the real Electron module here (it can't run under bun test).
 * Instead the handlers are stubbed by `__debugIpcHandlersForTest` so we can
 * call them directly and assert on their return values.  Real-CDP integration
 * is covered by debug-session.test.ts; this file pins the IPC contract.
 */
import { describe, expect, it, beforeEach, mock } from 'bun:test'
import { isLoopbackWsUrl } from '../debug-ipc-pure'

describe('isLoopbackWsUrl', () => {
  it('accepts 127.0.0.1 with port + path', () => {
    expect(isLoopbackWsUrl('ws://127.0.0.1:9229/abc')).toBe(true)
  })
  it('accepts localhost with port', () => {
    expect(isLoopbackWsUrl('ws://localhost:9229/uuid')).toBe(true)
  })
  it('rejects wss://', () => {
    expect(isLoopbackWsUrl('wss://127.0.0.1:9229/x')).toBe(false)
  })
  it('rejects remote hostnames', () => {
    expect(isLoopbackWsUrl('ws://example.com:9229/x')).toBe(false)
    expect(isLoopbackWsUrl('ws://10.0.0.1:9229/x')).toBe(false)
    expect(isLoopbackWsUrl('ws://[::1]:9229/x')).toBe(false)
  })
  it('rejects missing port', () => {
    expect(isLoopbackWsUrl('ws://127.0.0.1/x')).toBe(false)
  })
  it('rejects non-numeric / out-of-range port', () => {
    expect(isLoopbackWsUrl('ws://127.0.0.1:0/x')).toBe(false)
    expect(isLoopbackWsUrl('ws://127.0.0.1:99999/x')).toBe(false)
  })
  it('rejects http://', () => {
    expect(isLoopbackWsUrl('http://127.0.0.1:9229/x')).toBe(false)
  })
  it('rejects empty / non-string', () => {
    expect(isLoopbackWsUrl('')).toBe(false)
    expect(isLoopbackWsUrl(undefined)).toBe(false)
    expect(isLoopbackWsUrl(42)).toBe(false)
  })
  it('rejects malformed URL', () => {
    expect(isLoopbackWsUrl('not a url')).toBe(false)
    expect(isLoopbackWsUrl('://nope')).toBe(false)
  })
})

// ─── handler-level tests (via injected fake session) ─────────────────

// Mock `electron` so importing debug-ipc doesn't blow up under bun.
mock.module('electron', () => ({
  ipcMain: { handle: () => undefined },
  BrowserWindow: { getAllWindows: () => [] },
}))

// Build a fake DebugSession that records all method calls.
interface FakeCalls {
  attach: number
  detach: number
  setBp: Array<{ url: string; lineNumber: number }>
  removeBp: string[]
  resume: number
  pause: number
  stepOver: number
  stepInto: number
  stepOut: number
  evaluate: string[]
}

function makeFakeSession(opts: { state?: string; failNext?: string } = {}) {
  const calls: FakeCalls = {
    attach: 0, detach: 0, setBp: [], removeBp: [],
    resume: 0, pause: 0, stepOver: 0, stepInto: 0, stepOut: 0, evaluate: [],
  }
  let failNext = opts.failNext
  const trip = (k: string) => {
    if (failNext === k) { failNext = undefined; throw new Error(`fake-fail:${k}`) }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const session: any = {
    state: opts.state ?? 'running',
    async attach() { calls.attach += 1 },
    async detach() { calls.detach += 1 },
    async setBreakpoint(args: { url: string; lineNumber: number }) {
      trip('setBp')
      calls.setBp.push(args)
      return { id: `bp${calls.setBp.length}`, url: args.url, lineNumber: args.lineNumber, locations: [] }
    },
    async removeBreakpoint(id: string) { trip('removeBp'); calls.removeBp.push(id) },
    async resume() { trip('resume'); calls.resume += 1 },
    async pause() { trip('pause'); calls.pause += 1 },
    async stepOver() { trip('stepOver'); calls.stepOver += 1 },
    async stepInto() { trip('stepInto'); calls.stepInto += 1 },
    async stepOut() { trip('stepOut'); calls.stepOut += 1 },
    async evaluate(expr: string) {
      trip('evaluate')
      calls.evaluate.push(expr)
      return { ok: true, text: '42', data: { type: 'number', value: 42 } }
    },
  }
  return { session, calls }
}

// We import after mocking electron above.  Use a top-level await dynamic
// import so the mock.module() above is in place before any module-load
// side effects of debug-ipc.ts run.
const debugIpc = await import('../debug-ipc')
const { __debugIpcInjectSessionForTest, __debugIpcClearForTest, __debugIpcHandlersForTest: H } = debugIpc

beforeEach(() => __debugIpcClearForTest())

describe('debug-ipc — start', () => {
  it('rejects invalid wsUrl', async () => {
    const r = await H.start(null, 'ws://example.com:9229/x')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/invalid wsUrl/)
  })
  it('rejects non-string wsUrl', async () => {
    const r = await H.start(null, 42 as unknown as string)
    expect(r.ok).toBe(false)
  })
})

describe('debug-ipc — guarded handlers (no session)', () => {
  it('setBreakpoint → no such session', async () => {
    const r = await H.setBreakpoint(null, 'nope', { url: 'x', lineNumber: 0 })
    expect(r.ok).toBe(false); expect(r.error).toBe('no such session')
  })
  it('removeBreakpoint → no such session', async () => {
    const r = await H.removeBreakpoint(null, 'nope', 'bp1')
    expect(r.ok).toBe(false); expect(r.error).toBe('no such session')
  })
  it('resume → no such session', async () => {
    const r = await H.resume(null, 'nope')
    expect(r.ok).toBe(false); expect(r.error).toBe('no such session')
  })
  it('evaluate → no such session', async () => {
    const r = await H.evaluate(null, 'nope', '1+1')
    expect(r.ok).toBe(false); expect(r.error).toBe('no such session')
  })
  it('detach → no-op succeeds even with unknown id', async () => {
    const r = await H.detach(null, 'nope')
    expect(r.ok).toBe(true)
  })
})

describe('debug-ipc — happy-path with injected session', () => {
  it('setBreakpoint', async () => {
    const { session, calls } = makeFakeSession()
    __debugIpcInjectSessionForTest({ sessionId: 'sid1', cdp: {} as never, session: session as never })
    const r = await H.setBreakpoint(null, 'sid1', { url: 'file:///a.js', lineNumber: 5 })
    expect(r.ok).toBe(true)
    expect(calls.setBp).toEqual([{ url: 'file:///a.js', lineNumber: 5 }])
  })
  it('setBreakpoint rejects bad args', async () => {
    const { session } = makeFakeSession()
    __debugIpcInjectSessionForTest({ sessionId: 'sid1', cdp: {} as never, session: session as never })
    const r = await H.setBreakpoint(null, 'sid1', { url: 42 as unknown as string, lineNumber: 5 })
    expect(r.ok).toBe(false); expect(r.error).toBe('invalid args')
  })
  it('removeBreakpoint', async () => {
    const { session, calls } = makeFakeSession()
    __debugIpcInjectSessionForTest({ sessionId: 'sid1', cdp: {} as never, session: session as never })
    const r = await H.removeBreakpoint(null, 'sid1', 'bp1')
    expect(r.ok).toBe(true)
    expect(calls.removeBp).toEqual(['bp1'])
  })
  it('removeBreakpoint rejects non-string id', async () => {
    const { session } = makeFakeSession()
    __debugIpcInjectSessionForTest({ sessionId: 'sid1', cdp: {} as never, session: session as never })
    const r = await H.removeBreakpoint(null, 'sid1', 42 as unknown as string)
    expect(r.ok).toBe(false)
  })
  it('step commands fan out correctly', async () => {
    const { session, calls } = makeFakeSession()
    __debugIpcInjectSessionForTest({ sessionId: 'sid1', cdp: {} as never, session: session as never })
    await H.resume(null, 'sid1')
    await H.pause(null, 'sid1')
    await H.stepOver(null, 'sid1')
    await H.stepInto(null, 'sid1')
    await H.stepOut(null, 'sid1')
    expect(calls.resume).toBe(1)
    expect(calls.pause).toBe(1)
    expect(calls.stepOver).toBe(1)
    expect(calls.stepInto).toBe(1)
    expect(calls.stepOut).toBe(1)
  })
  it('evaluate returns the inner result', async () => {
    const { session, calls } = makeFakeSession()
    __debugIpcInjectSessionForTest({ sessionId: 'sid1', cdp: {} as never, session: session as never })
    const r = await H.evaluate(null, 'sid1', '1+1')
    expect(r.ok).toBe(true)
    expect(r.result?.text).toBe('42')
    expect(calls.evaluate).toEqual(['1+1'])
  })
  it('evaluate rejects empty expression', async () => {
    const { session } = makeFakeSession()
    __debugIpcInjectSessionForTest({ sessionId: 'sid1', cdp: {} as never, session: session as never })
    const r = await H.evaluate(null, 'sid1', '')
    expect(r.ok).toBe(false); expect(r.error).toBe('empty expression')
  })
  it('evaluate rejects too-long expression', async () => {
    const { session } = makeFakeSession()
    __debugIpcInjectSessionForTest({ sessionId: 'sid1', cdp: {} as never, session: session as never })
    const r = await H.evaluate(null, 'sid1', 'x'.repeat(8193))
    expect(r.ok).toBe(false); expect(r.error).toMatch(/too long/)
  })
  it('list returns the live session', async () => {
    const { session } = makeFakeSession({ state: 'paused' })
    __debugIpcInjectSessionForTest({ sessionId: 'sid1', cdp: {} as never, session: session as never })
    const r = await H.list()
    expect(r.sessions).toEqual([{ sessionId: 'sid1', state: 'paused' }])
  })
  it('detach removes from registry', async () => {
    const { session, calls } = makeFakeSession()
    __debugIpcInjectSessionForTest({ sessionId: 'sid1', cdp: {} as never, session: session as never })
    await H.detach(null, 'sid1')
    expect(calls.detach).toBe(1)
    expect((await H.list()).sessions).toEqual([])
  })
})

describe('debug-ipc — error propagation', () => {
  it('setBreakpoint surfaces session errors', async () => {
    const { session } = makeFakeSession({ failNext: 'setBp' })
    __debugIpcInjectSessionForTest({ sessionId: 'sid1', cdp: {} as never, session: session as never })
    const r = await H.setBreakpoint(null, 'sid1', { url: 'a', lineNumber: 0 })
    expect(r.ok).toBe(false); expect(r.error).toContain('fake-fail:setBp')
  })
  it('resume surfaces session errors', async () => {
    const { session } = makeFakeSession({ failNext: 'resume' })
    __debugIpcInjectSessionForTest({ sessionId: 'sid1', cdp: {} as never, session: session as never })
    const r = await H.resume(null, 'sid1')
    expect(r.ok).toBe(false); expect(r.error).toContain('fake-fail:resume')
  })
})
