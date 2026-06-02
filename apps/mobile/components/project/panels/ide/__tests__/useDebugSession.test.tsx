// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the renderer-side DAP state machine.
 *
 * Two layers:
 *   1. Pure reducer — every action transition exercised deterministically.
 *   2. Hook integration — useDebugSession wired against a fake bridge that
 *      stages the run.start → onInspector → debug.start → onEvent dance.
 */
import { describe, expect, test, beforeEach } from 'bun:test'
import { act, renderHook, waitFor } from '@testing-library/react'
import {
  reducer,
  useDebugSession,
  type DebugBridge,
  type RunBridgeForDebug,
} from '../run/useDebugSession'

// ─── reducer ────────────────────────────────────────────────────────

describe('useDebugSession — reducer', () => {
  test('initial state is idle', () => {
    const s = reducer(undefined as never, { type: 'reset' })
    expect(s.state).toBe('idle')
    expect(s.console).toEqual([])
    expect(s.breakpoints).toEqual([])
  })

  test('starting → awaiting-ws → attaching → running → paused → resumed', () => {
    let s = reducer(undefined as never, { type: 'reset' })
    s = reducer(s, { type: 'starting', script: 'dev' })
    expect(s.state).toBe('starting')
    expect(s.script).toBe('dev')
    s = reducer(s, { type: 'await-ws', runId: 'r1' })
    expect(s.state).toBe('awaiting-ws')
    expect(s.runId).toBe('r1')
    s = reducer(s, { type: 'have-ws', wsUrl: 'ws://127.0.0.1:9229/x' })
    expect(s.state).toBe('attaching')
    expect(s.wsUrl).toBe('ws://127.0.0.1:9229/x')
    s = reducer(s, { type: 'session-id', sessionId: 'sid1' })
    s = reducer(s, { type: 'attached' })
    expect(s.state).toBe('running')
    s = reducer(s, {
      type: 'paused', reason: 'breakpoint',
      frames: [{ callFrameId: 'f1', functionName: 'main', url: 'file:///a.js', lineNumber: 5, columnNumber: 0 }],
    })
    expect(s.state).toBe('paused')
    expect(s.callFrames).toHaveLength(1)
    s = reducer(s, { type: 'resumed' })
    expect(s.state).toBe('running')
    expect(s.callFrames).toEqual([])
  })

  test('failed action carries error', () => {
    let s = reducer(undefined as never, { type: 'reset' })
    s = reducer(s, { type: 'failed', error: 'boom' })
    expect(s.state).toBe('failed')
    expect(s.error).toBe('boom')
  })

  test('console accumulates and caps at 1000 entries', () => {
    let s = reducer(undefined as never, { type: 'reset' })
    for (let i = 0; i < 1100; i++) {
      s = reducer(s, { type: 'console', ev: { level: 'log', text: String(i), ts: i } })
    }
    expect(s.console.length).toBe(1000)
    // Oldest entries dropped, latest preserved.
    expect(s.console[0]!.text).toBe('100')
    expect(s.console[999]!.text).toBe('1099')
  })

  test('add-bp + remove-bp manages breakpoints list', () => {
    let s = reducer(undefined as never, { type: 'reset' })
    s = reducer(s, { type: 'add-bp', bp: { id: 'bp1', url: 'a', lineNumber: 1 } })
    s = reducer(s, { type: 'add-bp', bp: { id: 'bp2', url: 'b', lineNumber: 2 } })
    expect(s.breakpoints).toHaveLength(2)
    s = reducer(s, { type: 'remove-bp', id: 'bp1' })
    expect(s.breakpoints).toEqual([{ id: 'bp2', url: 'b', lineNumber: 2 }])
  })

  test('detached preserves prior runId/sessionId for diagnostics', () => {
    let s = reducer(undefined as never, { type: 'reset' })
    s = reducer(s, { type: 'starting', script: 'x' })
    s = reducer(s, { type: 'await-ws', runId: 'r1' })
    s = reducer(s, { type: 'session-id', sessionId: 's1' })
    s = reducer(s, { type: 'detached', reason: 'closed by host' })
    expect(s.state).toBe('detached')
    expect(s.error).toBe('closed by host')
    expect(s.runId).toBe('r1')
    expect(s.sessionId).toBe('s1')
  })

  test('clear-console empties the buffer', () => {
    let s = reducer(undefined as never, { type: 'reset' })
    s = reducer(s, { type: 'console', ev: { level: 'log', text: 'hi', ts: 0 } })
    s = reducer(s, { type: 'clear-console' })
    expect(s.console).toEqual([])
  })
})

// ─── hook integration via fake bridge ────────────────────────────────

interface FakeBridgeState {
  inspectorCb: ((info: { runId: string; wsUrl: string }) => void) | null
  eventCb: ((ev: { type: string; payload: unknown }) => void) | null
  exitCb: ((info: { code: number | null; signal: string | null }) => void) | null
  detachedSession: string | null
  bpCounter: number
}

function makeFakeBridges(): { run: RunBridgeForDebug; debug: DebugBridge; ctl: FakeBridgeState } {
  const ctl: FakeBridgeState = {
    inspectorCb: null, eventCb: null, exitCb: null, detachedSession: null, bpCounter: 0,
  }
  const run: RunBridgeForDebug = {
    async start() { return { ok: true, runId: 'run-1' } },
    async stop() { return { ok: true } },
    onOutput() { return () => undefined },
    onExit(_runId, cb) { ctl.exitCb = cb; return () => { ctl.exitCb = null } },
    onInspector(_runId, cb) { ctl.inspectorCb = cb; return () => { ctl.inspectorCb = null } },
  }
  const debug: DebugBridge = {
    async start() { return { ok: true, sessionId: 'sess-1' } },
    async setBreakpoint(_sid, args) {
      ctl.bpCounter += 1
      return { ok: true, bp: { id: `bp${ctl.bpCounter}`, url: args.url, lineNumber: args.lineNumber } }
    },
    async removeBreakpoint() { return { ok: true } },
    async resume() { return { ok: true } },
    async pause() { return { ok: true } },
    async stepOver() { return { ok: true } },
    async stepInto() { return { ok: true } },
    async stepOut() { return { ok: true } },
    async evaluate(_sid, expr) {
      return { ok: true, result: { ok: true, text: `="${expr}"`, data: { type: 'string', value: expr } } }
    },
    async detach(sid) { ctl.detachedSession = sid; return { ok: true } },
    onEvent(_sid, cb) { ctl.eventCb = cb; return () => { ctl.eventCb = null } },
  }
  return { run, debug, ctl }
}

describe('useDebugSession — happy path', () => {
  let bridges: ReturnType<typeof makeFakeBridges>
  beforeEach(() => { bridges = makeFakeBridges() })

  test('completes full start → attach → paused → resumed flow', async () => {
    const { result } = renderHook(() => useDebugSession('/tmp/proj', bridges))
    expect(result.current.state.state).toBe('idle')

    await act(async () => { await result.current.start('dev') })

    // After start(): the hook is waiting for v8's ws URL because run.start didn't carry one.
    await waitFor(() => expect(result.current.state.state).toBe('awaiting-ws'))
    expect(bridges.ctl.inspectorCb).not.toBeNull()

    // Fire the inspector URL event.
    await act(async () => { bridges.ctl.inspectorCb!({ runId: 'run-1', wsUrl: 'ws://127.0.0.1:9229/x' }) })

    await waitFor(() => expect(result.current.state.state).toBe('running'))
    expect(result.current.state.sessionId).toBe('sess-1')
    expect(result.current.state.wsUrl).toBe('ws://127.0.0.1:9229/x')

    // Simulate v8 hitting a breakpoint.
    await act(async () => {
      bridges.ctl.eventCb!({
        type: 'paused',
        payload: {
          reason: 'breakpoint',
          callFrames: [{ callFrameId: 'f1', functionName: 'main', url: 'file:///a.js', lineNumber: 5, columnNumber: 0 }],
        },
      })
    })
    expect(result.current.state.state).toBe('paused')
    expect(result.current.state.callFrames).toHaveLength(1)

    // Resume.
    await act(async () => {
      await result.current.resume()
      bridges.ctl.eventCb!({ type: 'resumed', payload: null })
    })
    expect(result.current.state.state).toBe('running')
  })

  test('console events accumulate', async () => {
    const { result } = renderHook(() => useDebugSession('/tmp/proj', bridges))
    await act(async () => { await result.current.start('dev') })
    await act(async () => { bridges.ctl.inspectorCb!({ runId: 'run-1', wsUrl: 'ws://127.0.0.1:9229/x' }) })
    await waitFor(() => expect(result.current.state.state).toBe('running'))

    await act(async () => {
      bridges.ctl.eventCb!({ type: 'console', payload: { level: 'log', text: 'hello' } })
      bridges.ctl.eventCb!({ type: 'console', payload: { level: 'error', text: 'oops' } })
    })
    expect(result.current.state.console).toHaveLength(2)
    expect(result.current.state.console[0]!.text).toBe('hello')
    expect(result.current.state.console[1]!.level).toBe('error')
  })

  test('exception event surfaces as console.error', async () => {
    const { result } = renderHook(() => useDebugSession('/tmp/proj', bridges))
    await act(async () => { await result.current.start('dev') })
    await act(async () => { bridges.ctl.inspectorCb!({ runId: 'run-1', wsUrl: 'ws://127.0.0.1:9229/x' }) })
    await waitFor(() => expect(result.current.state.state).toBe('running'))
    await act(async () => {
      bridges.ctl.eventCb!({ type: 'exception', payload: { text: 'TypeError: x is not a function' } })
    })
    expect(result.current.state.console).toHaveLength(1)
    expect(result.current.state.console[0]!.level).toBe('error')
    expect(result.current.state.console[0]!.text).toMatch(/TypeError/)
  })

  test('addBreakpoint updates the bp list', async () => {
    const { result } = renderHook(() => useDebugSession('/tmp/proj', bridges))
    await act(async () => { await result.current.start('dev') })
    await act(async () => { bridges.ctl.inspectorCb!({ runId: 'run-1', wsUrl: 'ws://127.0.0.1:9229/x' }) })
    await waitFor(() => expect(result.current.state.state).toBe('running'))
    await act(async () => { await result.current.addBreakpoint({ url: 'file:///a.js', lineNumber: 5 }) })
    expect(result.current.state.breakpoints).toEqual([{ id: 'bp1', url: 'file:///a.js', lineNumber: 5 }])
    await act(async () => { await result.current.removeBreakpoint('bp1') })
    expect(result.current.state.breakpoints).toEqual([])
  })

  test('evaluate returns the bridge result', async () => {
    const { result } = renderHook(() => useDebugSession('/tmp/proj', bridges))
    await act(async () => { await result.current.start('dev') })
    await act(async () => { bridges.ctl.inspectorCb!({ runId: 'run-1', wsUrl: 'ws://127.0.0.1:9229/x' }) })
    await waitFor(() => expect(result.current.state.state).toBe('running'))
    let r: { ok: boolean; text: string } | undefined
    await act(async () => { r = await result.current.evaluate('foo') })
    expect(r).toEqual({ ok: true, text: '="foo"' })
  })

  test('evaluate before attach returns no-session', async () => {
    const { result } = renderHook(() => useDebugSession('/tmp/proj', bridges))
    const r = await result.current.evaluate('1+1')
    expect(r.ok).toBe(false)
    expect(r.text).toBe('no active session')
  })

  test('stop detaches + resets state', async () => {
    const { result } = renderHook(() => useDebugSession('/tmp/proj', bridges))
    await act(async () => { await result.current.start('dev') })
    await act(async () => { bridges.ctl.inspectorCb!({ runId: 'run-1', wsUrl: 'ws://127.0.0.1:9229/x' }) })
    await waitFor(() => expect(result.current.state.state).toBe('running'))
    await act(async () => { await result.current.stop() })
    expect(bridges.ctl.detachedSession).toBe('sess-1')
    expect(result.current.state.state).toBe('idle')
  })
})

describe('useDebugSession — failure paths', () => {
  test('no bridge surfaces a failed state', async () => {
    const { result } = renderHook(() => useDebugSession('/tmp/proj', undefined))
    await act(async () => { await result.current.start('dev') })
    expect(result.current.state.state).toBe('failed')
    expect(result.current.state.error).toMatch(/desktop app/)
  })

  test('run.start failure surfaces the error', async () => {
    const bridges = makeFakeBridges()
    bridges.run.start = async () => ({ ok: false, error: 'spawn EACCES' })
    const { result } = renderHook(() => useDebugSession('/tmp/proj', bridges))
    await act(async () => { await result.current.start('dev') })
    expect(result.current.state.state).toBe('failed')
    expect(result.current.state.error).toBe('spawn EACCES')
  })

  test('debug.start failure surfaces the error', async () => {
    const bridges = makeFakeBridges()
    bridges.debug.start = async () => ({ ok: false, error: 'cdp refused' })
    const { result } = renderHook(() => useDebugSession('/tmp/proj', bridges))
    await act(async () => { await result.current.start('dev') })
    await act(async () => { bridges.ctl.inspectorCb!({ runId: 'run-1', wsUrl: 'ws://127.0.0.1:9229/x' }) })
    await waitFor(() => expect(result.current.state.state).toBe('failed'))
    expect(result.current.state.error).toBe('cdp refused')
  })

  test('process exits before inspector URL appears → failed', async () => {
    const bridges = makeFakeBridges()
    const { result } = renderHook(() => useDebugSession('/tmp/proj', bridges))
    await act(async () => { await result.current.start('dev') })
    await waitFor(() => expect(result.current.state.state).toBe('awaiting-ws'))
    // Process exits before any inspector URL is printed.
    await act(async () => { bridges.ctl.exitCb!({ code: 1, signal: null }) })
    // detached transitions us to 'detached' state.
    expect(result.current.state.state).toBe('detached')
  })
})
