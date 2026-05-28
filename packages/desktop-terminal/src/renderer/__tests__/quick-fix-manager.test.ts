// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'bun:test'
import { Osc633Tracker, type CommandMarker, type MarkerFactory } from '../osc633-tracker'
import { OscDecoder } from '@shogo/pty-core'
import type { DecorationHandle, DecorationHost, DecorationOptions } from '../command-decorations'
import {
  QuickFixManager,
  type BufferReader,
  type QuickFixClickEvent,
} from '../quick-fix/quick-fix-manager'
import { QuickFixEngine } from '../quick-fix/quick-fix-engine'
import { BUILT_IN_RULES } from '../quick-fix/quick-fix-rules'

// ─── helpers ──────────────────────────────────────────────────────

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
function feed(t: Osc633Tracker, s: string): void {
  const r = new OscDecoder().feed(enc(s))
  t.feedAll(r.events)
}

interface FakeEl {
  textContent: string
  style: Record<string, string>
  attrs: Record<string, string>
  className: string
  listeners: Record<string, ((ev: unknown) => void)[]>
  setAttribute(k: string, v: string): void
  getAttribute(k: string): string | null
  addEventListener(t: string, cb: (ev: unknown) => void): void
}

function makeEl(): FakeEl {
  return {
    textContent: '',
    style: {},
    attrs: {},
    className: '',
    listeners: {},
    setAttribute(k, v) { this.attrs[k] = v },
    getAttribute(k) { return this.attrs[k] ?? null },
    addEventListener(t, cb) { (this.listeners[t] ??= []).push(cb) },
  }
}

interface RegisteredDecoration {
  opts: DecorationOptions
  handle: DecorationHandle
  element: FakeEl
  disposed: boolean
  paint(): FakeEl
}

function makeHost(): { host: DecorationHost; decorations: RegisteredDecoration[] } {
  const decorations: RegisteredDecoration[] = []
  return {
    decorations,
    host: {
      registerDecoration(opts) {
        const el = makeEl()
        let renderCb: ((el: HTMLElement) => void) | undefined
        const rec: RegisteredDecoration = {
          opts, element: el, disposed: false,
          handle: {
            onRender(cb) { renderCb = cb },
            dispose() { rec.disposed = true },
          },
          paint() { renderCb?.(el as unknown as HTMLElement); return el },
        }
        decorations.push(rec)
        return rec.handle
      },
    },
  }
}

function makeMarkers(): MarkerFactory & { count(): number } {
  let n = 0
  return {
    registerMarker(): CommandMarker { n += 1; return { line: n * 10 } },
    count(): number { return n },
  }
}

/** Buffer that returns canned rows. */
function makeBuffer(rowMap: Record<number, string> = {}, defaultLine = ''): BufferReader {
  return {
    readRows(start, end) {
      const out: string[] = []
      for (let i = start; i < end; i++) out.push(rowMap[i] ?? defaultLine)
      return out
    },
  }
}

// ─── lifecycle ────────────────────────────────────────────────────

describe('QuickFixManager — lifecycle', () => {
  it('registers a lightbulb decoration when a non-zero command finishes with matching output', () => {
    const tracker = new Osc633Tracker(makeMarkers())
    const { host, decorations } = makeHost()
    const events: QuickFixClickEvent[] = []
    const buf = makeBuffer({ 20: 'EADDRINUSE: address already in use 0.0.0.0:3000' }, '')
    new QuickFixManager({
      tracker, host, buffer: buf,
      onSuggestion: (ev) => events.push(ev),
    })
    feed(tracker, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;E;npm run dev\x07\x1b]633;C\x07\x1b]633;D;1\x07')
    expect(decorations).toHaveLength(1)
    const el = decorations[0]!.paint()
    expect(el.textContent).toBe('💡')
    expect(el.attrs['data-quick-fix-count']).toBe('1')
    expect(el.attrs.role).toBe('button')
    // Click fires onSuggestion with the rule's run payload.
    for (const cb of el.listeners.click ?? []) cb({ button: 0 } as unknown as MouseEvent)
    expect(events).toHaveLength(1)
    expect(events[0]!.suggestion.action.payload).toContain('lsof -t -i :3000')
    expect(events[0]!.command.exitCode).toBe(1)
  })

  it('skips successful commands', () => {
    const tracker = new Osc633Tracker(makeMarkers())
    const { host, decorations } = makeHost()
    const buf = makeBuffer({ 20: 'EADDRINUSE 3000' })
    new QuickFixManager({ tracker, host, buffer: buf, onSuggestion: () => undefined })
    feed(tracker, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;0\x07')
    expect(decorations).toHaveLength(0)
  })

  it('skips when no rule matches the output', () => {
    const tracker = new Osc633Tracker(makeMarkers())
    const { host, decorations } = makeHost()
    const buf = makeBuffer({}, 'all good, no problems here')
    new QuickFixManager({ tracker, host, buffer: buf, onSuggestion: () => undefined })
    feed(tracker, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;1\x07')
    expect(decorations).toHaveLength(0)
  })

  it('skips when output spans an empty marker range', () => {
    const tracker = new Osc633Tracker({
      registerMarker(): CommandMarker { return { line: 10 } }, // all markers on same line
    })
    const { host, decorations } = makeHost()
    let bufRead = 0
    const buf: BufferReader = { readRows() { bufRead++; return [] } }
    new QuickFixManager({ tracker, host, buffer: buf, onSuggestion: () => undefined })
    feed(tracker, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;1\x07')
    // Manager bails before reading the buffer when end <= start.
    expect(bufRead).toBe(0)
    expect(decorations).toHaveLength(0)
  })

  it('adopts commands that finished before mount', () => {
    const tracker = new Osc633Tracker(makeMarkers())
    feed(tracker, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;1\x07')
    // Mount AFTER the failure has been recorded.
    const { host, decorations } = makeHost()
    const buf = makeBuffer({ 20: 'EADDRINUSE 0.0.0.0:8080' })
    new QuickFixManager({
      tracker, host, buffer: buf,
      onSuggestion: () => undefined,
    })
    expect(decorations).toHaveLength(1)
  })

  it('dispose releases all handles and stops listening', () => {
    const tracker = new Osc633Tracker(makeMarkers())
    const { host, decorations } = makeHost()
    const buf = makeBuffer({ 20: 'EADDRINUSE 0.0.0.0:3000' })
    const mgr = new QuickFixManager({
      tracker, host, buffer: buf, onSuggestion: () => undefined,
    })
    feed(tracker, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;1\x07')
    mgr.dispose()
    expect(decorations.every((d) => d.disposed)).toBe(true)
    // Subsequent command-finished events do nothing.
    feed(tracker, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;1\x07')
    expect(decorations).toHaveLength(1)
    mgr.dispose() // idempotent
  })
})

// ─── invoke + lookup ──────────────────────────────────────────────

describe('QuickFixManager — invoke', () => {
  it('invokes a suggestion by command id + index', () => {
    const tracker = new Osc633Tracker(makeMarkers())
    const { host } = makeHost()
    const events: QuickFixClickEvent[] = []
    const buf = makeBuffer({ 20: "Cannot find module 'lodash'" })
    const mgr = new QuickFixManager({
      tracker, host, buffer: buf,
      onSuggestion: (ev) => events.push(ev),
    })
    feed(tracker, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;E;node app.js\x07\x1b]633;C\x07\x1b]633;D;1\x07')
    expect(mgr.size()).toBe(1)
    const id = mgr.has(1) ? 1 : -1
    expect(mgr.invoke(id, 0, { button: 0 } as unknown as MouseEvent)).toBe(true)
    expect(events[0]!.suggestion.action.payload).toBe('npm install lodash')
  })

  it('returns false for unknown command id or out-of-range index', () => {
    const tracker = new Osc633Tracker(makeMarkers())
    const { host } = makeHost()
    const buf = makeBuffer({ 20: 'EADDRINUSE :3000' })
    const mgr = new QuickFixManager({ tracker, host, buffer: buf, onSuggestion: () => undefined })
    feed(tracker, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;1\x07')
    expect(mgr.invoke(999, 0, {} as MouseEvent)).toBe(false)
    expect(mgr.invoke(1, 99, {} as MouseEvent)).toBe(false)
  })
})

// ─── custom rules ─────────────────────────────────────────────────

describe('QuickFixManager — custom rules via engine', () => {
  it('lets hosts inject rules into the engine', () => {
    const tracker = new Osc633Tracker(makeMarkers())
    const { host, decorations } = makeHost()
    const buf = makeBuffer({ 20: 'CustomFailure!' })
    const engine = new QuickFixEngine({ rules: [] })
    engine.addRule({
      id: 'custom',
      label: 'custom',
      matches: ({ outputTail }) =>
        outputTail.includes('CustomFailure')
          ? [{ ruleId: 'custom', title: 'Fix it', confidence: 'high', action: { kind: 'run', payload: 'echo fixed' } }]
          : [],
    })
    new QuickFixManager({ tracker, host, buffer: buf, engine, onSuggestion: () => undefined })
    feed(tracker, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;1\x07')
    expect(decorations).toHaveLength(1)
    const el = decorations[0]!.paint()
    expect(el.attrs['aria-label']).toContain('Fix it')
  })
})

// ─── decoration metadata ─────────────────────────────────────────

describe('QuickFixManager — decoration metadata', () => {
  it('anchors on endMarker when available, falls back to startMarker / promptMarker', () => {
    const tracker = new Osc633Tracker(makeMarkers())
    const { host, decorations } = makeHost()
    const buf = makeBuffer({ 20: 'EADDRINUSE :3000', 30: 'EADDRINUSE :3000', 40: 'EADDRINUSE :3000' })
    new QuickFixManager({
      tracker, host, buffer: buf,
      // Use built-ins so we know the rule will match.
      engine: new QuickFixEngine({ rules: BUILT_IN_RULES }),
      onSuggestion: () => undefined,
    })
    feed(tracker, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;1\x07')
    // makeMarkers gives lines [10, 20, 30, 40, ...] — A=10, C=20, D=30.
    // endMarker is line 30.
    expect(decorations).toHaveLength(1)
    expect(decorations[0]!.opts.marker.line).toBe(30)
    expect(decorations[0]!.opts.overviewRulerOptions?.color).toBe('#f5d76e')
  })
})
