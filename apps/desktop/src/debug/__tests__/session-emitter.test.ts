// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, it, beforeEach } from 'bun:test'
import {
  DebugSessionEmitter,
  getDebugSessionEmitter,
  __resetDebugSessionEmitterForTest,
} from '../session-emitter'

describe('DebugSessionEmitter', () => {
  let em: DebugSessionEmitter
  beforeEach(() => { em = new DebugSessionEmitter() })

  it('assigns monotonically increasing ids', () => {
    const a = em.stdout('one')
    const b = em.stdout('two')
    const c = em.stderr('three')
    expect(a.id).toBe(1)
    expect(b.id).toBe(2)
    expect(c.id).toBe(3)
  })

  it('fans out events to all listeners in subscription order', () => {
    const seen: string[] = []
    em.on((e) => seen.push(`A:${e.text}`))
    em.on((e) => seen.push(`B:${e.text}`))
    em.stdout('hello')
    expect(seen).toEqual(['A:hello', 'B:hello'])
  })

  it('unsubscribe handle removes the listener', () => {
    const seen: string[] = []
    const off = em.on((e) => seen.push(e.text))
    em.stdout('a')
    off()
    em.stdout('b')
    expect(seen).toEqual(['a'])
  })

  it('isolates listener exceptions', () => {
    const seen: string[] = []
    em.on(() => { throw new Error('boom') })
    em.on((e) => seen.push(e.text))
    em.stdout('after-boom')
    expect(seen).toEqual(['after-boom'])
  })

  it('preserves caller-supplied id/ts when given', () => {
    const ev = em.emit({ kind: 'stdout', text: 'x', id: 99, ts: 12345 })
    expect(ev.id).toBe(99)
    expect(ev.ts).toBe(12345)
    // Next auto-id still increments from the default counter (not the override).
    const next = em.stdout('y')
    expect(next.id).toBe(1)
  })

  it('console.log carries structured data', () => {
    const ev = em.consoleLog('printed', { foo: 1, nested: [2, 3] }, 'script.js:7')
    expect(ev.kind).toBe('console.log')
    expect(ev.data).toEqual({ foo: 1, nested: [2, 3] })
    expect(ev.source).toBe('script.js:7')
  })

  it('attached() emits a system event the first time only', () => {
    const seen: string[] = []
    em.on((e) => seen.push(`${e.kind}:${e.text}`))
    em.markAttached('node.js')
    em.markAttached('node.js')
    expect(em.isAttached).toBe(true)
    expect(seen).toEqual(['system:Attached to node.js'])
  })

  it('detached() is a no-op when not attached', () => {
    const seen: string[] = []
    em.on((e) => seen.push(e.text))
    em.markDetached()
    expect(seen).toEqual([])
  })

  it('attach → detach toggles state', () => {
    em.markAttached('x')
    expect(em.isAttached).toBe(true)
    em.markDetached('manual')
    expect(em.isAttached).toBe(false)
  })

  it('dispose() drops all listeners', () => {
    const seen: string[] = []
    em.on((e) => seen.push(e.text))
    em.dispose()
    em.stdout('after-dispose')
    expect(seen).toEqual([])
  })
})

describe('getDebugSessionEmitter singleton', () => {
  beforeEach(() => __resetDebugSessionEmitterForTest())

  it('returns the same instance across calls', () => {
    expect(getDebugSessionEmitter()).toBe(getDebugSessionEmitter())
  })

  it('reset replaces the singleton with a fresh instance', () => {
    const a = getDebugSessionEmitter()
    __resetDebugSessionEmitterForTest()
    const b = getDebugSessionEmitter()
    expect(a).not.toBe(b)
  })
})
