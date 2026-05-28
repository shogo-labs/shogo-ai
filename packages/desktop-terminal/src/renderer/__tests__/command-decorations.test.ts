// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'bun:test'
import { Osc633Tracker, type MarkerFactory, type CommandMarker } from '../osc633-tracker'
import { OscDecoder } from '@shogo/pty-core'
import {
  CommandDecorations,
  DEFAULT_STYLES,
  classify,
  type DecorationOptions,
  type DecorationHandle,
} from '../command-decorations'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

// ─── fake xterm host ────────────────────────────────────────────────────

interface FakeEl {
  textContent: string
  style: Record<string, string>
  attrs: Record<string, string>
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
  /** Render the decoration once and expose the painted element. */
  paint(): FakeEl
}

function makeHost(): { host: { registerDecoration(o: DecorationOptions): DecorationHandle }, decorations: RegisteredDecoration[] } {
  const decorations: RegisteredDecoration[] = []
  return {
    decorations,
    host: {
      registerDecoration(opts: DecorationOptions): DecorationHandle {
        const el = makeEl()
        let renderCb: ((el: HTMLElement) => void) | undefined
        const rec: RegisteredDecoration = {
          opts,
          element: el,
          disposed: false,
          handle: {
            onRender(cb) { renderCb = cb },
            dispose() { rec.disposed = true },
          },
          paint(): FakeEl {
            renderCb?.(el as unknown as HTMLElement)
            return el
          },
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
    registerMarker(): CommandMarker { n += 1; return { line: n } },
    count(): number { return n },
  }
}

function feed(t: Osc633Tracker, s: string): void {
  const r = new OscDecoder().feed(enc(s))
  t.feedAll(r.events)
}

// ─── classify ───────────────────────────────────────────────────────────

describe('classify', () => {
  it('returns success for exit 0', () => {
    expect(classify({ state: 'finished', exitCode: 0 } as never)).toBe('success')
  })
  it('returns failure for exit > 0', () => {
    expect(classify({ state: 'finished', exitCode: 1 } as never)).toBe('failure')
  })
  it('returns interrupted for exit null + finished', () => {
    expect(classify({ state: 'finished', exitCode: null } as never)).toBe('interrupted')
  })
  it('returns running for non-finished states', () => {
    expect(classify({ state: 'running', exitCode: null } as never)).toBe('running')
    expect(classify({ state: 'awaiting', exitCode: null } as never)).toBe('running')
    expect(classify({ state: 'prompting', exitCode: null } as never)).toBe('running')
  })
})

// ─── lifecycle ──────────────────────────────────────────────────────────

describe('CommandDecorations — lifecycle', () => {
  it('registers a decoration on command-started and replaces it on command-finished', () => {
    const t = new Osc633Tracker(makeMarkers())
    const { host, decorations } = makeHost()
    const deco = new CommandDecorations({ host, tracker: t })

    feed(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07')
    // One running decoration registered (start of command).
    expect(decorations.length).toBe(1)
    expect(decorations[0]!.disposed).toBe(false)
    const running = decorations[0]!.paint()
    expect(running.textContent).toBe(DEFAULT_STYLES.running.glyph)

    feed(t, '\x1b]633;D;0\x07')
    // Running decoration disposed; success decoration registered.
    expect(decorations[0]!.disposed).toBe(true)
    expect(decorations.length).toBe(2)
    const finished = decorations[1]!.paint()
    expect(finished.textContent).toBe(DEFAULT_STYLES.success.glyph)
    expect(finished.style.color).toBe(DEFAULT_STYLES.success.color)
    deco.dispose()
  })

  it('paints ✗ for non-zero exit', () => {
    const t = new Osc633Tracker(makeMarkers())
    const { host, decorations } = makeHost()
    new CommandDecorations({ host, tracker: t })
    feed(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;7\x07')
    const finished = decorations[decorations.length - 1]!.paint()
    expect(finished.textContent).toBe('✗')
    expect(finished.attrs['data-command-kind']).toBe('failure')
  })

  it('paints ⏸ for interrupted (D with no exit / non-numeric)', () => {
    const t = new Osc633Tracker(makeMarkers())
    const { host, decorations } = makeHost()
    new CommandDecorations({ host, tracker: t })
    feed(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D\x07')
    const finished = decorations[decorations.length - 1]!.paint()
    expect(finished.attrs['data-command-kind']).toBe('interrupted')
  })

  it('attaches an overview-ruler colour by kind', () => {
    const t = new Osc633Tracker(makeMarkers())
    const { host, decorations } = makeHost()
    new CommandDecorations({ host, tracker: t })
    feed(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;0\x07')
    feed(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;1\x07')
    const successDeco = decorations.find((d) => d.opts.overviewRulerOptions?.color === DEFAULT_STYLES.success.color)
    const failureDeco = decorations.find((d) => d.opts.overviewRulerOptions?.color === DEFAULT_STYLES.failure.color)
    expect(successDeco).toBeTruthy()
    expect(failureDeco).toBeTruthy()
    expect(successDeco!.opts.overviewRulerOptions!.position).toBe('right')
  })
})

// ─── click handling ────────────────────────────────────────────────────

describe('CommandDecorations — onClick', () => {
  it('fires onClick with command + kind + mouseEvent when the gutter is clicked', () => {
    const t = new Osc633Tracker(makeMarkers())
    const { host, decorations } = makeHost()
    const seen: unknown[] = []
    new CommandDecorations({ host, tracker: t, onClick: (e) => seen.push(e) })
    feed(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;0\x07')
    const el = decorations[decorations.length - 1]!.paint()
    const fakeEvent = { type: 'click' }
    for (const cb of el.listeners.click ?? []) cb(fakeEvent)
    expect(seen).toHaveLength(1)
    const e = seen[0] as { command: { exitCode: number }, kind: string, mouseEvent: unknown }
    expect(e.kind).toBe('success')
    expect(e.command.exitCode).toBe(0)
    expect(e.mouseEvent).toBe(fakeEvent)
  })
})

// ─── adoption ──────────────────────────────────────────────────────────

describe('CommandDecorations — adopts pre-existing commands', () => {
  it('renders decorations for commands the tracker already had before mount', () => {
    const t = new Osc633Tracker(makeMarkers())
    feed(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;0\x07')
    feed(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;1\x07')
    // tracker now has 2 finished commands. Mount decorations AFTER.
    const { host, decorations } = makeHost()
    const deco = new CommandDecorations({ host, tracker: t })
    expect(decorations.length).toBe(2)
    expect(deco.size()).toBe(2)
    expect(deco.has(1)).toBe(true)
    expect(deco.has(2)).toBe(true)
  })

  it('also adopts the in-progress current command on mount', () => {
    const t = new Osc633Tracker(makeMarkers())
    feed(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07')
    const { host, decorations } = makeHost()
    new CommandDecorations({ host, tracker: t })
    expect(decorations.length).toBe(1)
  })
})

// ─── dispose ───────────────────────────────────────────────────────────

describe('CommandDecorations — dispose', () => {
  it('releases all handles and stops listening', () => {
    const t = new Osc633Tracker(makeMarkers())
    const { host, decorations } = makeHost()
    const deco = new CommandDecorations({ host, tracker: t })
    feed(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;0\x07')
    deco.dispose()
    expect(decorations.every((d) => d.disposed)).toBe(true)
    expect(deco.size()).toBe(0)
    // Feeding more events after dispose must not create new decorations.
    feed(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;0\x07')
    // (no new ones added)
    expect(decorations.length).toBe(2) // initial running + finished only
  })

  it('is idempotent', () => {
    const t = new Osc633Tracker(makeMarkers())
    const { host } = makeHost()
    const deco = new CommandDecorations({ host, tracker: t })
    deco.dispose()
    deco.dispose()
  })
})

// ─── showRunning option ────────────────────────────────────────────────

describe('CommandDecorations — showRunning=false', () => {
  it('only renders on finish, not on start', () => {
    const t = new Osc633Tracker(makeMarkers())
    const { host, decorations } = makeHost()
    new CommandDecorations({ host, tracker: t, showRunning: false })
    feed(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07')
    expect(decorations.length).toBe(0)
    feed(t, '\x1b]633;D;0\x07')
    expect(decorations.length).toBe(1)
  })
})

// ─── style override ────────────────────────────────────────────────────

describe('CommandDecorations — custom styles', () => {
  it('uses overridden glyph/colour', () => {
    const t = new Osc633Tracker(makeMarkers())
    const { host, decorations } = makeHost()
    new CommandDecorations({
      host,
      tracker: t,
      styles: { success: { glyph: '★', color: '#abc', ariaLabel: 'OK' } },
    })
    feed(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;0\x07')
    const el = decorations[decorations.length - 1]!.paint()
    expect(el.textContent).toBe('★')
    expect(el.style.color).toBe('#abc')
    expect(el.attrs['aria-label']).toBe('OK')
  })
})
