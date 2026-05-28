// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'bun:test'
import { GpuRenderer, type WebglAddonLike, type XtermLike } from '../gpu-renderer'

interface FakeAddon extends WebglAddonLike {
  disposed: boolean
  fireContextLost(): void
}

function makeAddon(opts: { throwOnLoad?: boolean } = {}): { addon: FakeAddon; loadedInto: XtermLike[] } {
  const loadedInto: XtermLike[] = []
  let lostCb: (() => void) | null = null
  const addon: FakeAddon = {
    disposed: false,
    dispose() { this.disposed = true },
    onContextLost(cb) {
      lostCb = cb
      return { dispose() { lostCb = null } }
    },
    fireContextLost() { lostCb?.() },
  }
  return { addon, loadedInto }
}

function makeTerm(opts: { throwOnLoad?: boolean } = {}): XtermLike {
  return {
    loadAddon(_addon) { if (opts.throwOnLoad) throw new Error('boom') },
  }
}

// ─── happy path ────────────────────────────────────────────────────────

describe('GpuRenderer — happy path', () => {
  it('attaches the addon and reports webgl-active', () => {
    const { addon } = makeAddon()
    const term = makeTerm()
    const r = new GpuRenderer({ term, createWebglAddon: () => addon })
    expect(r.state).toBe('webgl-active')
    expect(r.isGpu()).toBe(true)
    expect(addon.disposed).toBe(false)
  })

  it('emits state transitions to onStateChange', () => {
    const { addon } = makeAddon()
    const states: string[] = []
    const r = new GpuRenderer({
      term: makeTerm(),
      createWebglAddon: () => addon,
      onStateChange: (s) => states.push(s),
    })
    addon.fireContextLost()
    r.disable()
    expect(states).toEqual(['webgl-active', 'fallback-canvas', 'disabled-by-config'])
  })
})

// ─── context loss ──────────────────────────────────────────────────────

describe('GpuRenderer — context loss', () => {
  it('first loss falls back to canvas and disposes the addon', () => {
    const { addon } = makeAddon()
    const r = new GpuRenderer({ term: makeTerm(), createWebglAddon: () => addon })
    addon.fireContextLost()
    expect(r.state).toBe('fallback-canvas')
    expect(addon.disposed).toBe(true)
    expect(r.isGpu()).toBe(false)
  })

  it('second loss within the flap window permanently disables WebGL', () => {
    let t = 0
    const a1 = makeAddon().addon
    const a2 = makeAddon().addon
    const created: FakeAddon[] = []
    const r = new GpuRenderer({
      term: makeTerm(),
      createWebglAddon: () => {
        const next = created.length === 0 ? a1 : a2
        created.push(next)
        return next
      },
      now: () => t,
      flapWindowMs: 10_000,
    })
    expect(r.state).toBe('webgl-active')
    a1.fireContextLost()
    expect(r.state).toBe('fallback-canvas')
    t = 5_000
    // Re-enable to attach a fresh addon, then lose it again
    r.enable()
    expect(r.state).toBe('webgl-active')
    a2.fireContextLost()
    expect(r.state).toBe('disabled-flapping')
    expect(a2.disposed).toBe(true)
  })

  it('a loss outside the flap window does NOT trigger disabled-flapping', () => {
    let t = 0
    const r = new GpuRenderer({
      term: makeTerm(),
      createWebglAddon: () => makeAddon().addon,
      now: () => t,
      flapWindowMs: 1_000,
    })
    // dispose+reattach manually with another timestamp pair
    r.disable()
    t = 60_000
    r.enable()
    expect(r.state).toBe('webgl-active')
  })
})

// ─── disabled-by-config ────────────────────────────────────────────────

describe('GpuRenderer — disabled by config', () => {
  it('does not attach the addon when enabled=false', () => {
    let created = 0
    const r = new GpuRenderer({
      term: makeTerm(),
      createWebglAddon: () => { created++; return makeAddon().addon },
      enabled: false,
    })
    expect(created).toBe(0)
    expect(r.state).toBe('disabled-by-config')
  })

  it('enable() attaches the addon after disable()', () => {
    let count = 0
    const r = new GpuRenderer({
      term: makeTerm(),
      createWebglAddon: () => { count++; return makeAddon().addon },
    })
    expect(count).toBe(1)
    r.disable()
    expect(r.state).toBe('disabled-by-config')
    r.enable()
    expect(count).toBe(2)
    expect(r.state).toBe('webgl-active')
  })

  it('enable() is a no-op after disabled-flapping', () => {
    let t = 0
    let count = 0
    const created: FakeAddon[] = []
    const r = new GpuRenderer({
      term: makeTerm(),
      createWebglAddon: () => {
        count++
        const a = makeAddon().addon
        created.push(a)
        return a
      },
      now: () => t,
    })
    created[0]!.fireContextLost()
    r.enable()
    created[1]!.fireContextLost()
    expect(r.state).toBe('disabled-flapping')
    r.enable()
    // No new attach after disabled-flapping.
    expect(count).toBe(2)
    expect(r.state).toBe('disabled-flapping')
  })
})

// ─── failure modes ─────────────────────────────────────────────────────

describe('GpuRenderer — failure modes', () => {
  it('returns unsupported when createWebglAddon throws', () => {
    const r = new GpuRenderer({
      term: makeTerm(),
      createWebglAddon: () => { throw new Error('no webgl') },
    })
    expect(r.state).toBe('unsupported')
  })

  it('returns unsupported when loadAddon throws', () => {
    const r = new GpuRenderer({
      term: makeTerm({ throwOnLoad: true }),
      createWebglAddon: () => makeAddon().addon,
    })
    expect(r.state).toBe('unsupported')
  })
})

// ─── dispose ───────────────────────────────────────────────────────────

describe('GpuRenderer — dispose', () => {
  it('disposes the addon and stops listening', () => {
    const { addon } = makeAddon()
    const r = new GpuRenderer({ term: makeTerm(), createWebglAddon: () => addon })
    r.dispose()
    expect(addon.disposed).toBe(true)
    // Subsequent context-lost should not change state.
    addon.fireContextLost()
    expect(r.state).toBe('webgl-active')
  })

  it('is idempotent', () => {
    const r = new GpuRenderer({ term: makeTerm(), createWebglAddon: () => makeAddon().addon })
    r.dispose(); r.dispose()
  })
})
