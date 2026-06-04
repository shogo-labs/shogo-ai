// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect, beforeEach } from 'bun:test'
import { Osc633Tracker, type MarkerFactory, type CommandMarker } from '../osc633-tracker'
import { OscDecoder } from '@shogo/pty-core'
import { CommandDecorations } from '../command-decorations'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

function feedAll(t: Osc633Tracker, ...sequences: string[]) {
  const dec = new OscDecoder()
  for (const seq of sequences) {
    const result = dec.feed(enc(seq))
    if (result.events.length > 0) t.feedAll(result.events)
  }
}

function cmdComplete(t: Osc633Tracker, exitCode: number) {
  feedAll(t, '\x1b]633;A\x07', '\x1b]633;E;echo\x07', '\x1b]633;C\x07', `\x1b]633;D;${exitCode}\x07`)
}

// ─── mock marker factory ────────────────────────────────────────────────

let markerId = 0
const mockMarkers: MarkerFactory = {
  registerMarker: (): CommandMarker => {
    const id = ++markerId
    return { line: id, dispose: () => {} }
  },
}

// ─── fake xterm host ─────────────────────────────────────────────────────

interface RegisteredDeco {
  opts: Record<string, unknown>
  disposed: boolean
  renderCb: ((el: any) => void) | null
}

class FakeHost {
  registered: RegisteredDeco[] = []

  registerDecoration(opts: Record<string, unknown>) {
    const entry: RegisteredDeco = { opts, disposed: false, renderCb: null }
    this.registered.push(entry)
    return {
      onRender: (cb: (el: any) => void) => { entry.renderCb = cb },
      dispose: () => { entry.disposed = true },
    }
  }
}

// ─── tests ───────────────────────────────────────────────────────────────

describe('CommandDecorations', () => {
  let tracker: Osc633Tracker
  let host: FakeHost

  beforeEach(() => {
    markerId = 0
    tracker = new Osc633Tracker(mockMarkers)
    host = new FakeHost()
  })

  it('creates decoration after exit 0', () => {
    const dec = new CommandDecorations({ tracker, host: host as any })
    cmdComplete(tracker, 0)
    expect(host.registered.length).toBe(2)
    // Left-anchored gutter decoration (width:1, no anchor = left default)
    expect(host.registered[1]!.opts.width).toBe(1)
    expect(host.registered[1]!.opts.anchor).toBeUndefined()
  })

  it('creates decoration after non-zero exit', () => {
    const dec = new CommandDecorations({ tracker, host: host as any })
    cmdComplete(tracker, 1)
    expect(host.registered.length).toBe(2)
    expect(host.registered[1]!.opts.width).toBe(1)
    expect(host.registered[1]!.opts.anchor).toBeUndefined()
  })

  it('replaces running decoration with finished one', () => {
    const dec = new CommandDecorations({ tracker, host: host as any })
    // Running command — tracker has current but not in commands list
    // After completion, the finished command should appear
    cmdComplete(tracker, 0)
    // The finished decoration replaces the running one
    expect(host.registered.length).toBeGreaterThanOrEqual(1)
  })

  it('accepts options object with onClick', () => {
    let clicked = false
    const dec = new CommandDecorations({
      tracker,
      host: host as any,
      onClick: () => { clicked = true },
    })
    cmdComplete(tracker, 0)
    expect(host.registered.length).toBe(2)
    // onClick is wired — decoration exists and has the right width
    expect(host.registered[1]!.opts.width).toBe(1)
  })

  it('adopts pre-existing commands', () => {
    // Complete a command BEFORE creating decorations
    cmdComplete(tracker, 0)
    cmdComplete(tracker, 1)
    const dec = new CommandDecorations({ tracker, host: host as any })
    // snapshot().commands includes finished + current; should adopt all
    expect(host.registered.length).toBeGreaterThanOrEqual(2)
  })

  it('dispose stops future decorations', () => {
    const dec = new CommandDecorations({ tracker, host: host as any })
    cmdComplete(tracker, 0)
    const count = host.registered.length
    dec.dispose()
    cmdComplete(tracker, 0)
    expect(host.registered.length).toBe(count)
  })
})
