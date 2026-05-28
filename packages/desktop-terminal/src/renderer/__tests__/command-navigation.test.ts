// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'bun:test'
import { Osc633Tracker, type CommandMarker, type MarkerFactory } from '../osc633-tracker'
import { OscDecoder } from '@shogo/pty-core'
import {
  CommandNavigation,
  collectPromptAnchors,
  findNextPromptLine,
  findPrevPromptLine,
  matchNavChord,
  type Platform,
  type PromptAnchor,
  type ScrollHost,
} from '../command-navigation'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

function feed(t: Osc633Tracker, s: string): void {
  const r = new OscDecoder().feed(enc(s))
  t.feedAll(r.events)
}

function makeMarkers(): MarkerFactory & { count(): number } {
  let n = 0
  return {
    registerMarker(): CommandMarker { n += 1; return { line: n * 10 } }, // simulate 10-line gaps
    count(): number { return n },
  }
}

// ─── pure arithmetic ────────────────────────────────────────────────────

describe('findPrevPromptLine / findNextPromptLine', () => {
  const anchors: PromptAnchor[] = [
    { id: 1, line: 10 },
    { id: 2, line: 50 },
    { id: 3, line: 100 },
  ]

  it('returns the largest anchor strictly less than currentLine', () => {
    expect(findPrevPromptLine(anchors, 60)?.id).toBe(2)
    expect(findPrevPromptLine(anchors, 50)?.id).toBe(1) // strict <
    expect(findPrevPromptLine(anchors, 10)).toBeNull()
    expect(findPrevPromptLine(anchors, 5)).toBeNull()
  })

  it('returns the smallest anchor strictly greater than currentLine', () => {
    expect(findNextPromptLine(anchors, 30)?.id).toBe(2)
    expect(findNextPromptLine(anchors, 50)?.id).toBe(3) // strict >
    expect(findNextPromptLine(anchors, 100)).toBeNull()
    expect(findNextPromptLine(anchors, 200)).toBeNull()
  })

  it('returns null for empty anchor list', () => {
    expect(findPrevPromptLine([], 10)).toBeNull()
    expect(findNextPromptLine([], 10)).toBeNull()
  })
})

// ─── collectPromptAnchors ───────────────────────────────────────────────

describe('collectPromptAnchors', () => {
  it('returns anchors sorted by line, including current', () => {
    const t = new Osc633Tracker(makeMarkers())
    feed(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;0\x07') // id 1, prompt line 10
    feed(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;0\x07') // id 2, prompt line 40 (4 markers each cmd)
    feed(t, '\x1b]633;A\x07') // current, prompt line ~70
    const anchors = collectPromptAnchors(t)
    expect(anchors.map((a) => a.id)).toEqual([1, 2, 3])
    for (let i = 1; i < anchors.length; i++) {
      expect(anchors[i]!.line).toBeGreaterThan(anchors[i - 1]!.line)
    }
  })

  it('skips commands whose promptMarker is missing', () => {
    const t = new Osc633Tracker() // no-op factory → no markers
    feed(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;0\x07')
    expect(collectPromptAnchors(t)).toEqual([])
  })

  it('skips anchors with non-finite line', () => {
    // tracker that hands out markers with NaN lines
    let n = 0
    const tracker = new Osc633Tracker({
      registerMarker: () => ({ line: ++n % 2 === 0 ? Number.NaN : n * 10 }),
    })
    feed(tracker, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;0\x07')
    feed(tracker, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;0\x07')
    const anchors = collectPromptAnchors(tracker)
    for (const a of anchors) expect(Number.isFinite(a.line)).toBe(true)
  })
})

// ─── matchNavChord ──────────────────────────────────────────────────────

const baseEv = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }

describe('matchNavChord — mac', () => {
  const plat: Platform = 'mac'
  it('matches ⌘↑ → prev', () => {
    expect(matchNavChord({ ...baseEv, key: 'ArrowUp', metaKey: true }, plat))
      .toEqual({ direction: 'prev', extend: false })
  })
  it('matches ⌘↓ → next', () => {
    expect(matchNavChord({ ...baseEv, key: 'ArrowDown', metaKey: true }, plat))
      .toEqual({ direction: 'next', extend: false })
  })
  it('matches ⇧⌘↑ → prev with extend', () => {
    expect(matchNavChord({ ...baseEv, key: 'ArrowUp', metaKey: true, shiftKey: true }, plat))
      .toEqual({ direction: 'prev', extend: true })
  })
  it('rejects bare ↑ on mac', () => {
    expect(matchNavChord({ ...baseEv, key: 'ArrowUp' }, plat)).toBeNull()
  })
  it('rejects ⌃⌘↑ (ctrl present)', () => {
    expect(matchNavChord({ ...baseEv, key: 'ArrowUp', metaKey: true, ctrlKey: true }, plat)).toBeNull()
  })
  it('rejects ⌥⌘↑ (alt present, mac means linux-only chord)', () => {
    expect(matchNavChord({ ...baseEv, key: 'ArrowUp', metaKey: true, altKey: true }, plat)).toBeNull()
  })
})

describe('matchNavChord — linux/win', () => {
  it('matches Alt+↑ on linux', () => {
    expect(matchNavChord({ ...baseEv, key: 'ArrowUp', altKey: true }, 'linux'))
      .toEqual({ direction: 'prev', extend: false })
  })
  it('matches Alt+↓ on win', () => {
    expect(matchNavChord({ ...baseEv, key: 'ArrowDown', altKey: true }, 'win'))
      .toEqual({ direction: 'next', extend: false })
  })
  it('rejects ⌘↑ on linux (no meta)', () => {
    expect(matchNavChord({ ...baseEv, key: 'ArrowUp', metaKey: true }, 'linux')).toBeNull()
  })
})

describe('matchNavChord — non-arrow keys ignored', () => {
  it('ignores ⌘k', () => {
    expect(matchNavChord({ ...baseEv, key: 'k', metaKey: true }, 'mac')).toBeNull()
  })
  it('ignores Tab', () => {
    expect(matchNavChord({ ...baseEv, key: 'Tab', metaKey: true }, 'mac')).toBeNull()
  })
})

// ─── CommandNavigation.move ────────────────────────────────────────────

function makeScrollHost(initialLine = 0): ScrollHost & { calls: { scrollToLine: number[], selectLines: [number, number][] } } {
  const state = { line: initialLine }
  const calls = { scrollToLine: [] as number[], selectLines: [] as [number, number][] }
  return {
    calls,
    getCurrentLine: () => state.line,
    scrollToLine(line: number) { state.line = line; calls.scrollToLine.push(line) },
    selectLines(a: number, b: number) { calls.selectLines.push([a, b]) },
  }
}

describe('CommandNavigation.move', () => {
  it('scrolls to the previous prompt anchor', () => {
    const t = new Osc633Tracker(makeMarkers())
    feed(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;0\x07') // prompt 10
    feed(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;0\x07') // prompt 40
    feed(t, '\x1b]633;A\x07') // current prompt 70
    const host = makeScrollHost(100) // viewport on bottom
    const nav = new CommandNavigation({ host, tracker: t, platform: 'mac' })
    expect(nav.move('prev', false)).toBe(true)
    expect(host.calls.scrollToLine).toEqual([70])
    nav.dispose()
  })

  it('scrolls to the next prompt anchor', () => {
    const t = new Osc633Tracker(makeMarkers())
    feed(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;0\x07') // prompt 10
    feed(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;0\x07') // prompt 40
    const host = makeScrollHost(5)
    const nav = new CommandNavigation({ host, tracker: t, platform: 'mac' })
    expect(nav.move('next', false)).toBe(true)
    expect(host.calls.scrollToLine).toEqual([10])
  })

  it('returns false when no anchor exists in that direction', () => {
    const t = new Osc633Tracker(makeMarkers())
    feed(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;0\x07') // prompt 10
    const host = makeScrollHost(5)
    const nav = new CommandNavigation({ host, tracker: t })
    expect(nav.move('prev', false)).toBe(false)
    expect(host.calls.scrollToLine).toEqual([])
  })

  it('extends selection when extend=true and host supports it', () => {
    const t = new Osc633Tracker(makeMarkers())
    feed(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;0\x07') // prompt 10
    const host = makeScrollHost(50)
    const nav = new CommandNavigation({ host, tracker: t })
    expect(nav.move('prev', true)).toBe(true)
    expect(host.calls.selectLines).toEqual([[10, 50]])
  })
})

// ─── handleKeyDown ─────────────────────────────────────────────────────

describe('CommandNavigation.handleKeyDown', () => {
  it('consumes ⌘↑ and preventDefault on mac', () => {
    const t = new Osc633Tracker(makeMarkers())
    feed(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;0\x07')
    const host = makeScrollHost(100)
    const nav = new CommandNavigation({ host, tracker: t, platform: 'mac' })
    let prevented = false
    const ev = {
      key: 'ArrowUp', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false,
      preventDefault: () => { prevented = true },
    } as unknown as KeyboardEvent
    expect(nav.handleKeyDown(ev)).toBe(true)
    expect(prevented).toBe(true)
    expect(host.calls.scrollToLine).toEqual([10])
  })

  it('does not consume unrelated keys', () => {
    const t = new Osc633Tracker(makeMarkers())
    const host = makeScrollHost(100)
    const nav = new CommandNavigation({ host, tracker: t, platform: 'mac' })
    let prevented = false
    const ev = {
      key: 'a', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
      preventDefault: () => { prevented = true },
    } as unknown as KeyboardEvent
    expect(nav.handleKeyDown(ev)).toBe(false)
    expect(prevented).toBe(false)
  })
})

// ─── attachTo lifecycle ────────────────────────────────────────────────

describe('CommandNavigation.attachTo', () => {
  it('subscribes a keydown listener and removes it on dispose', () => {
    const t = new Osc633Tracker(makeMarkers())
    const host = makeScrollHost()
    const listeners: { type: string, cb: EventListener }[] = []
    const target = {
      addEventListener(t: string, cb: EventListener) { listeners.push({ type: t, cb }) },
      removeEventListener(t: string, cb: EventListener) {
        const idx = listeners.findIndex((l) => l.type === t && l.cb === cb)
        if (idx >= 0) listeners.splice(idx, 1)
      },
    }
    const nav = new CommandNavigation({ host, tracker: t, attachTo: target })
    expect(listeners.length).toBe(1)
    expect(listeners[0]!.type).toBe('keydown')
    nav.dispose()
    expect(listeners.length).toBe(0)
  })
})
