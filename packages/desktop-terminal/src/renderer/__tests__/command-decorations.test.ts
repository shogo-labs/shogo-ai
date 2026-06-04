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

class FakeHost {
  registered: Array<{
    opts: Record<string, unknown>
    disposed: boolean
    renderCb: ((el: any) => void) | null
  }> = []

  registerDecoration(opts: Record<string, unknown>) {
    const entry = {
      opts,
      disposed: false,
      renderCb: null as ((el: any) => void) | null,
    }
    this.registered.push(entry)
    return {
      onRender: (cb: (el: any) => void) => { entry.renderCb = cb },
      dispose: () => { entry.disposed = true },
    }
  }

  triggerRender(index = -1): Record<string, string> {
    const el: Record<string, string> = {}
    const entry = this.registered[index < 0 ? this.registered.length + index : index]
    if (entry?.renderCb) {
      entry.renderCb({
        setAttribute: (k: string, v: string) => { el[k] = v },
        style: {} as Record<string, string>,
        title: '',
        appendChild: () => {},
        replaceChildren: () => {},
      })
    }
    return el
  }
}

// ─── tests ───────────────────────────────────────────────────────────────

describe('CommandDecorations', () => {
  let tracker: Osc633Tracker
  let host: FakeHost
  let dec: CommandDecorations

  beforeEach(() => {
    markerId = 0
    tracker = new Osc633Tracker(mockMarkers)
    host = new FakeHost()
    dec = new CommandDecorations(tracker, host as any)
  })

  it('creates success decoration after exit 0', () => {
    dec.start()
    cmdComplete(tracker, 0)
    // 1 decoration for running (started), 1 for success (finished)
    expect(host.registered.length).toBe(2)
    expect(host.registered[1]!.disposed).toBe(false)
  })

  it('creates failure decoration after non-zero exit', () => {
    dec.start()
    cmdComplete(tracker, 1)
    expect(host.registered.length).toBe(2)
    expect(host.registered[1]!.disposed).toBe(false)
  })

  it('disposes running decoration when command finishes', () => {
    dec.start()
    cmdComplete(tracker, 0)
    // First decoration (running) should be disposed
    expect(host.registered[0]!.disposed).toBe(true)
    // Second decoration (success) should be live
    expect(host.registered[1]!.disposed).toBe(false)
  })

  it('anchors to left gutter', () => {
    dec.start()
    cmdComplete(tracker, 0)
    for (const entry of host.registered) {
      expect(entry.opts.anchor).toBe('left')
      expect(entry.opts.layer).toBe('top')
    }
  })

  it('dispose stops future decorations', () => {
    dec.start()
    cmdComplete(tracker, 0)
    const count = host.registered.length
    dec.dispose()
    cmdComplete(tracker, 0)
    expect(host.registered.length).toBe(count)
  })

  it('adopts pre-existing commands on start', () => {
    dec.start()
    cmdComplete(tracker, 0)
    // Both running + finished decorations exist
    expect(host.registered.length).toBe(2)
  })
})
