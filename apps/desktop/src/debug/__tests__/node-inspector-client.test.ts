// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, it } from 'bun:test'
import {
  inspectorListUrl,
  discoverInspectorTargets,
  startDebugAttacher,
  DEFAULT_INSPECTOR_PORT,
  type FetchLike,
  type InspectorTarget,
} from '../node-inspector-client'
import { DebugSessionEmitter } from '../session-emitter'

const SAMPLE_TARGET: InspectorTarget = {
  description: 'node.js instance',
  type: 'node',
  title: 'demo.js',
  url: 'file:///tmp/demo.js',
  webSocketDebuggerUrl: 'ws://127.0.0.1:9229/abc-uuid',
  id: 'abc-uuid',
}

function fakeFetch(map: Record<string, unknown>): FetchLike {
  return async (url) => {
    if (url in map) {
      const body = map[url]
      return { ok: true, status: 200, async json() { return body } }
    }
    throw new Error('ECONNREFUSED')
  }
}

describe('inspectorListUrl', () => {
  it('builds default-host URL', () => {
    expect(inspectorListUrl(9229)).toBe('http://127.0.0.1:9229/json/list')
  })
  it('honors custom host', () => {
    expect(inspectorListUrl(9230, 'localhost')).toBe('http://localhost:9230/json/list')
  })
})

describe('discoverInspectorTargets', () => {
  it('returns [] when nothing is listening', async () => {
    const targets = await discoverInspectorTargets({
      ports: [DEFAULT_INSPECTOR_PORT],
      fetch: fakeFetch({}),
    })
    expect(targets).toEqual([])
  })

  it('returns parsed targets with host+port annotated', async () => {
    const targets = await discoverInspectorTargets({
      ports: [9229],
      fetch: fakeFetch({ 'http://127.0.0.1:9229/json/list': [SAMPLE_TARGET] }),
    })
    expect(targets).toHaveLength(1)
    expect(targets[0]?.id).toBe('abc-uuid')
    expect(targets[0]?.host).toBe('127.0.0.1')
    expect(targets[0]?.port).toBe(9229)
  })

  it('skips malformed entries but keeps the good ones', async () => {
    const bad = { id: 'nope' }
    const targets = await discoverInspectorTargets({
      ports: [9229],
      fetch: fakeFetch({ 'http://127.0.0.1:9229/json/list': [bad, SAMPLE_TARGET] }),
    })
    expect(targets).toHaveLength(1)
    expect(targets[0]?.id).toBe('abc-uuid')
  })

  it('treats non-array body as empty', async () => {
    const targets = await discoverInspectorTargets({
      ports: [9229],
      fetch: fakeFetch({ 'http://127.0.0.1:9229/json/list': { not: 'an array' } }),
    })
    expect(targets).toEqual([])
  })

  it('scans multiple ports and merges results', async () => {
    const t2 = { ...SAMPLE_TARGET, id: 'two', webSocketDebuggerUrl: 'ws://127.0.0.1:9230/two' }
    const targets = await discoverInspectorTargets({
      ports: [9229, 9230, 9231],
      fetch: fakeFetch({
        'http://127.0.0.1:9229/json/list': [SAMPLE_TARGET],
        'http://127.0.0.1:9230/json/list': [t2],
      }),
    })
    expect(targets.map((t) => t.id).sort()).toEqual(['abc-uuid', 'two'])
  })

  it('one port erroring does not nuke the others', async () => {
    const failingFetch: FetchLike = async (url) => {
      if (url.includes('9229')) throw new Error('boom')
      return { ok: true, status: 200, async json() { return [SAMPLE_TARGET] } }
    }
    const targets = await discoverInspectorTargets({
      ports: [9229, 9230],
      fetch: failingFetch,
    })
    expect(targets).toHaveLength(1)
    expect(targets[0]?.port).toBe(9230)
  })
})

describe('startDebugAttacher', () => {
  it('emits "attached" when a target appears', async () => {
    const em = new DebugSessionEmitter()
    const seen: string[] = []
    em.on((e) => seen.push(`${e.kind}:${e.text}`))

    const handle = startDebugAttacher({
      emitter: em,
      intervalMs: 1_000_000, // effectively disable polling — we drive refresh() manually
      ports: [9229],
      fetch: fakeFetch({ 'http://127.0.0.1:9229/json/list': [SAMPLE_TARGET] }),
    })
    await handle.refresh()
    handle.stop()

    expect(em.isAttached).toBe(true)
    expect(seen.some((s) => s === 'system:Attached to demo.js')).toBe(true)
    expect(handle.attachedKeys()).toEqual(['ws://127.0.0.1:9229/abc-uuid'])
  })

  it('emits "detached" when a previously-seen target disappears', async () => {
    const em = new DebugSessionEmitter()

    // First cycle: target visible.
    let cycle = 0
    const fetchImpl: FetchLike = async (url) => {
      cycle += 1
      if (cycle === 1 && url.includes('9229')) {
        return { ok: true, status: 200, async json() { return [SAMPLE_TARGET] } }
      }
      throw new Error('ECONNREFUSED')
    }

    const handle = startDebugAttacher({
      emitter: em,
      intervalMs: 1_000_000,
      ports: [9229],
      fetch: fetchImpl,
    })

    await handle.refresh()
    expect(handle.attachedKeys()).toHaveLength(1)

    const seen: string[] = []
    em.on((e) => seen.push(e.text))
    await handle.refresh()
    handle.stop()

    expect(handle.attachedKeys()).toHaveLength(0)
    expect(seen.some((t) => t.startsWith('Detached'))).toBe(true)
  })

  it('does not double-emit "attached" for a target that stays alive', async () => {
    const em = new DebugSessionEmitter()
    const seen: string[] = []
    em.on((e) => { if (e.kind === 'system') seen.push(e.text) })

    const handle = startDebugAttacher({
      emitter: em,
      intervalMs: 1_000_000,
      ports: [9229],
      fetch: fakeFetch({ 'http://127.0.0.1:9229/json/list': [SAMPLE_TARGET] }),
    })
    await handle.refresh()
    await handle.refresh()
    await handle.refresh()
    handle.stop()

    expect(seen).toEqual(['Attached to demo.js'])
  })
})
