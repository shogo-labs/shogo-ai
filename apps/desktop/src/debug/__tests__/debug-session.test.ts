// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, it, beforeEach } from 'bun:test'
import { CdpClient, type WebSocketLike, type WebSocketFactory } from '../cdp-client'
import { DebugSession, formatRemoteObject } from '../debug-session'
import { DebugSessionEmitter } from '../session-emitter'


async function tick(times = 4) { for (let i = 0; i < times; i++) await Promise.resolve() }

// ─── deterministic fake WebSocket (shared with cdp-client.test.ts pattern) ──

interface FakeWs extends WebSocketLike {
  sent: string[]
  fireOpen(): void
  fireMessage(payload: unknown): void
  fireClose(code: number, reason: string): void
  replyTo(method: string, result: unknown): void
}

function makeFakeCdp(): { client: CdpClient; ws: FakeWs } {
  let ws!: FakeWs
  const factory: WebSocketFactory = () => {
    const handlers: Record<string, Array<(ev: unknown) => void>> = {
      open: [], message: [], close: [], error: [],
    }
    ws = {
      readyState: 0,
      sent: [],
      send(data: string) { this.sent.push(data) },
      close() { /* simulated */ },
      addEventListener(event: 'open' | 'message' | 'close' | 'error', cb: (ev: unknown) => void) {
        handlers[event].push(cb)
      },
      fireOpen() { this.readyState = 1; handlers.open.forEach((c) => c(undefined)) },
      fireMessage(payload: unknown) {
        const data = typeof payload === 'string' ? payload : JSON.stringify(payload)
        handlers.message.forEach((c) => c({ data }))
      },
      fireClose(code, reason) { this.readyState = 3; handlers.close.forEach((c) => c({ code, reason })) },
      // Convenience: find the last unanswered request matching `method` and reply.
      replyTo(method: string, result: unknown) {
        for (let i = this.sent.length - 1; i >= 0; i--) {
          const m = JSON.parse(this.sent[i]!) as { id: number; method: string }
          if (m.method === method) {
            this.fireMessage({ id: m.id, result })
            return
          }
        }
        throw new Error(`replyTo: no pending ${method}`)
      },
    }
    return ws
  }
  const client = new CdpClient({ url: 'ws://x/abc', wsFactory: factory })
  return { client, ws: ws! }
}

// ─── formatRemoteObject (pure helper) ────────────────────────────────

describe('formatRemoteObject', () => {
  it('handles primitives', () => {
    expect(formatRemoteObject({ type: 'string', value: 'hi' })).toBe('"hi"')
    expect(formatRemoteObject({ type: 'number', value: 42 })).toBe('42')
    expect(formatRemoteObject({ type: 'boolean', value: true })).toBe('true')
    expect(formatRemoteObject({ type: 'undefined' })).toBe('undefined')
    expect(formatRemoteObject({ type: 'object', subtype: 'null' })).toBe('null')
  })
  it('handles unserializable values (NaN/Infinity)', () => {
    expect(formatRemoteObject({ type: 'number', unserializableValue: 'NaN' })).toBe('NaN')
    expect(formatRemoteObject({ type: 'number', unserializableValue: 'Infinity' })).toBe('Infinity')
  })
  it('uses description for arrays/objects', () => {
    expect(formatRemoteObject({ type: 'object', subtype: 'array', description: 'Array(3)' })).toBe('Array(3)')
    expect(formatRemoteObject({ type: 'object', description: 'Foo { a: 1 }' })).toBe('Foo { a: 1 }')
  })
  it('handles functions', () => {
    expect(formatRemoteObject({ type: 'function', description: 'function foo()\n  …' })).toBe('function foo()')
  })
  it('handles bare null/undefined', () => {
    expect(formatRemoteObject(null)).toBe('null')
    expect(formatRemoteObject(undefined)).toBe('undefined')
  })
})

// ─── attach lifecycle ────────────────────────────────────────────────

describe('DebugSession — attach', () => {
  it('throws if attach() called twice', async () => {
    const { client, ws } = makeFakeCdp()
    const session = new DebugSession({ cdp: client })
    const p = session.attach()
    ws.fireOpen()
    await tick()
    ws.replyTo('Runtime.enable', {})
    await tick()
    ws.replyTo('Debugger.enable', {})
    await p
    expect(session.state).toBe('running')
    await expect(session.attach()).rejects.toThrow(/state running/)
  })

  it('transitions through attaching → running', async () => {
    const { client, ws } = makeFakeCdp()
    const states: string[] = []
    const session = new DebugSession({ cdp: client, on: { onState: (s) => states.push(s) } })
    const p = session.attach()
    expect(states).toContain('attaching')
    ws.fireOpen()
    await tick()
    ws.replyTo('Runtime.enable', {})
    await tick()
    ws.replyTo('Debugger.enable', {})
    await p
    expect(states[states.length - 1]).toBe('running')
  })

  it('emits "Attached to <label>" on the emitter', async () => {
    const em = new DebugSessionEmitter()
    const sysMsgs: string[] = []
    em.on((e) => { if (e.kind === 'system') sysMsgs.push(e.text) })
    const { client, ws } = makeFakeCdp()
    const session = new DebugSession({ cdp: client, emitter: em, label: 'demo.js' })
    const p = session.attach()
    ws.fireOpen()
    await tick()
    ws.replyTo('Runtime.enable', {})
    await tick()
    ws.replyTo('Debugger.enable', {})
    await p
    expect(sysMsgs).toContain('Attached to demo.js')
  })

  it('marks closed if Runtime.enable fails', async () => {
    const { client, ws } = makeFakeCdp()
    const session = new DebugSession({ cdp: client })
    const p = session.attach()
    ws.fireOpen()
    await tick()
    // Reply with an error to Runtime.enable
    const sent = JSON.parse(ws.sent[ws.sent.length - 1]!) as { id: number }
    ws.fireMessage({ id: sent.id, error: { code: -32000, message: 'denied' } })
    await expect(p).rejects.toThrow(/denied/)
    expect(session.state).toBe('closed')
  })
})

// ─── breakpoints ─────────────────────────────────────────────────────

describe('DebugSession — breakpoints', () => {
  async function attached() {
    const { client, ws } = makeFakeCdp()
    const session = new DebugSession({ cdp: client })
    const p = session.attach()
    ws.fireOpen()
    await tick()
    ws.replyTo('Runtime.enable', {})
    await tick()
    ws.replyTo('Debugger.enable', {})
    await p
    return { client, ws, session }
  }

  it('records the breakpoint id + locations', async () => {
    const { ws, session } = await attached()
    const bpP = session.setBreakpoint({ url: 'file:///a.js', lineNumber: 5 })
    await tick()
    ws.replyTo('Debugger.setBreakpointByUrl', {
      breakpointId: '1:5:0:file:///a.js',
      locations: [{ scriptId: '42', lineNumber: 5, columnNumber: 0 }],
    })
    const bp = await bpP
    expect(bp.id).toBe('1:5:0:file:///a.js')
    expect(bp.locations).toHaveLength(1)
    expect(session.listBreakpoints).toHaveLength(1)
  })

  it('removeBreakpoint drops it from the map', async () => {
    const { ws, session } = await attached()
    const bpP = session.setBreakpoint({ url: 'file:///a.js', lineNumber: 5 })
    await tick()
    ws.replyTo('Debugger.setBreakpointByUrl', { breakpointId: 'bp1', locations: [] })
    const bp = await bpP
    const rmP = session.removeBreakpoint(bp.id)
    await tick()
    ws.replyTo('Debugger.removeBreakpoint', {})
    await rmP
    expect(session.listBreakpoints).toHaveLength(0)
  })

  it('throws if attach was never called', async () => {
    const { client } = makeFakeCdp()
    const session = new DebugSession({ cdp: client })
    await expect(session.setBreakpoint({ url: 'x', lineNumber: 0 })).rejects.toThrow(/attach\(\) was not called/)
  })

  it('throws if session is closed', async () => {
    const { ws, session } = await attached()
    ws.fireClose(1000, 'gone')
    await expect(session.setBreakpoint({ url: 'x', lineNumber: 0 })).rejects.toThrow(/closed/)
  })
})

// ─── paused/resumed events ───────────────────────────────────────────

describe('DebugSession — pause / resume', () => {
  async function attached() {
    const { client, ws } = makeFakeCdp()
    const seen: { kind: string; payload: unknown }[] = []
    const session = new DebugSession({
      cdp: client,
      on: {
        onPaused: (ev) => seen.push({ kind: 'paused', payload: ev }),
        onResumed: () => seen.push({ kind: 'resumed', payload: null }),
        onConsoleApi: (ev) => seen.push({ kind: 'console', payload: ev }),
        onException: (ev) => seen.push({ kind: 'exception', payload: ev }),
      },
    })
    const p = session.attach()
    ws.fireOpen()
    await tick()
    ws.replyTo('Runtime.enable', {})
    await tick()
    ws.replyTo('Debugger.enable', {})
    await p
    return { client, ws, session, seen }
  }

  it('Debugger.paused transitions to paused + fires onPaused', async () => {
    const { ws, session, seen } = await attached()
    ws.fireMessage({
      method: 'Debugger.paused',
      params: {
        reason: 'breakpoint',
        hitBreakpoints: ['bp1'],
        callFrames: [
          { callFrameId: 'frame1', functionName: 'main', url: 'file:///a.js', location: { scriptId: '1', lineNumber: 5, columnNumber: 0 } },
          { callFrameId: 'frame2', functionName: '', url: 'file:///a.js', location: { scriptId: '1', lineNumber: 10, columnNumber: 0 } },
        ],
      },
    })
    expect(session.state).toBe('paused')
    const evt = seen.find((s) => s.kind === 'paused')!
    expect(evt).toBeDefined()
    const payload = evt.payload as { hitBreakpoints: string[]; callFrames: { functionName: string }[] }
    expect(payload.hitBreakpoints).toEqual(['bp1'])
    expect(payload.callFrames[1]!.functionName).toBe('(anonymous)')
  })

  it('Debugger.resumed transitions back to running', async () => {
    const { ws, session, seen } = await attached()
    ws.fireMessage({ method: 'Debugger.paused', params: { reason: 'other', callFrames: [] } })
    expect(session.state).toBe('paused')
    ws.fireMessage({ method: 'Debugger.resumed', params: {} })
    expect(session.state).toBe('running')
    expect(seen.some((s) => s.kind === 'resumed')).toBe(true)
  })

  it('step commands send the correct CDP method', async () => {
    const { ws, session } = await attached()
    void session.stepOver()
    void session.stepInto()
    void session.stepOut()
    void session.resume()
    void session.pause()
    await tick()
    const methods = ws.sent.slice(-5).map((s) => JSON.parse(s).method)
    expect(methods).toEqual([
      'Debugger.stepOver', 'Debugger.stepInto', 'Debugger.stepOut',
      'Debugger.resume', 'Debugger.pause',
    ])
  })
})

// ─── console + exception forwarding ──────────────────────────────────

describe('DebugSession — console + exceptions', () => {
  let em: DebugSessionEmitter
  beforeEach(() => { em = new DebugSessionEmitter() })

  async function attached() {
    const { client, ws } = makeFakeCdp()
    const session = new DebugSession({ cdp: client, emitter: em, label: 'demo' })
    const p = session.attach()
    ws.fireOpen()
    await tick()
    ws.replyTo('Runtime.enable', {})
    await tick()
    ws.replyTo('Debugger.enable', {})
    await p
    return { ws, session }
  }

  it('Runtime.consoleAPICalled (log) → emitter.console.log', async () => {
    const { ws } = await attached()
    const seen: { kind: string; text: string }[] = []
    em.on((e) => seen.push({ kind: e.kind, text: e.text }))
    ws.fireMessage({
      method: 'Runtime.consoleAPICalled',
      params: {
        type: 'log',
        args: [
          { type: 'string', value: 'hello' },
          { type: 'number', value: 42 },
        ],
        stackTrace: { callFrames: [{ url: 'file:///a.js', lineNumber: 6 }] },
      },
    })
    expect(seen.some((s) => s.kind === 'console.log' && s.text === '"hello" 42')).toBe(true)
  })

  it('Runtime.consoleAPICalled (error) maps to console.error pill', async () => {
    const { ws } = await attached()
    const seen: { kind: string; text: string }[] = []
    em.on((e) => seen.push({ kind: e.kind, text: e.text }))
    ws.fireMessage({
      method: 'Runtime.consoleAPICalled',
      params: { type: 'error', args: [{ type: 'string', value: 'oops' }] },
    })
    expect(seen.some((s) => s.kind === 'console.error' && s.text === '"oops"')).toBe(true)
  })

  it('Runtime.consoleAPICalled (warning) maps to console.warn pill', async () => {
    const { ws } = await attached()
    const seen: { kind: string; text: string }[] = []
    em.on((e) => seen.push({ kind: e.kind, text: e.text }))
    ws.fireMessage({
      method: 'Runtime.consoleAPICalled',
      params: { type: 'warning', args: [{ type: 'string', value: 'careful' }] },
    })
    expect(seen.some((s) => s.kind === 'console.warn')).toBe(true)
  })

  it('Runtime.exceptionThrown surfaces as console.error', async () => {
    const { ws } = await attached()
    const seen: { kind: string; text: string }[] = []
    em.on((e) => seen.push({ kind: e.kind, text: e.text }))
    ws.fireMessage({
      method: 'Runtime.exceptionThrown',
      params: { exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: x is not a function' } } },
    })
    expect(seen.some((s) => s.kind === 'console.error' && /TypeError/.test(s.text))).toBe(true)
  })
})

// ─── evaluate ────────────────────────────────────────────────────────

describe('DebugSession — evaluate', () => {
  async function attached() {
    const { client, ws } = makeFakeCdp()
    const session = new DebugSession({ cdp: client })
    const p = session.attach()
    ws.fireOpen()
    await tick()
    ws.replyTo('Runtime.enable', {})
    await tick()
    ws.replyTo('Debugger.enable', {})
    await p
    return { ws, session }
  }

  it('uses Runtime.evaluate at global scope', async () => {
    const { ws, session } = await attached()
    const p = session.evaluate('1+1')
    await tick()
    ws.replyTo('Runtime.evaluate', { result: { type: 'number', value: 2 } })
    const r = await p
    expect(r).toEqual({ ok: true, text: '2', data: { type: 'number', value: 2 } })
  })

  it('uses Debugger.evaluateOnCallFrame when paused', async () => {
    const { ws, session } = await attached()
    ws.fireMessage({
      method: 'Debugger.paused',
      params: { reason: 'breakpoint', callFrames: [
        { callFrameId: 'frame1', functionName: 'main', url: 'file:///a.js', location: { scriptId: '1', lineNumber: 0, columnNumber: 0 } },
      ] },
    })
    expect(session.state).toBe('paused')
    const p = session.evaluate('x')
    await tick()
    const lastReq = JSON.parse(ws.sent[ws.sent.length - 1]!) as { method: string; params: { callFrameId: string } }
    expect(lastReq.method).toBe('Debugger.evaluateOnCallFrame')
    expect(lastReq.params.callFrameId).toBe('frame1')
    await tick()
    ws.replyTo('Debugger.evaluateOnCallFrame', { result: { type: 'string', value: 'banana' } })
    const r = await p
    expect(r.ok).toBe(true)
    expect(r.text).toBe('"banana"')
  })

  it('surfaces exceptionDetails as ok:false', async () => {
    const { ws, session } = await attached()
    const p = session.evaluate('throw new Error("x")')
    ws.replyTo('Runtime.evaluate', {
      exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: x' } },
    })
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.text).toContain('Error: x')
  })
})

// ─── detach ──────────────────────────────────────────────────────────

describe('DebugSession — detach', () => {
  it('idempotent', async () => {
    const { client, ws } = makeFakeCdp()
    const session = new DebugSession({ cdp: client })
    const p = session.attach()
    ws.fireOpen()
    await tick()
    ws.replyTo('Runtime.enable', {})
    await tick()
    ws.replyTo('Debugger.enable', {})
    await p
    await session.detach()
    await session.detach()
    expect(session.state).toBe('closed')
  })

  it('socket close transitions session to closed', async () => {
    const { client, ws } = makeFakeCdp()
    let detachReason = ''
    const session = new DebugSession({
      cdp: client,
      on: { onDetached: (r) => { detachReason = r } },
    })
    const p = session.attach()
    ws.fireOpen()
    await tick()
    ws.replyTo('Runtime.enable', {})
    await tick()
    ws.replyTo('Debugger.enable', {})
    await p
    ws.fireClose(1006, 'remote-died')
    // The onAny handler watches state and fires onDetached once.
    expect(session.state).toBe('closed')
    expect(detachReason).toBe('socket closed')
  })
})
