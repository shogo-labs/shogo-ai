// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-357: the "Update available" affordance must never cover the user's app.
 *
 * Before this card the bridge drew a glowing pill pinned to the bottom of the
 * preview document, on top of the app's own nav, buttons and forms. Now:
 *   - a host that can draw the bar (Studio / the mobile app) acks with
 *     `canvas-host { updateBar: true }`; the bridge then only posts
 *     `canvas-update-available` to it and draws nothing;
 *   - with no host acks (standalone preview tab, AppPreviewPanel, the native
 *     WebView before its flag lands) the fallback bar is a slim full-width row
 *     pinned to the TOP, in the app's orange, and a `canvas-reload` message
 *     reloads the document.
 *
 * `canvas-bridge.js` is plain browser JS, so — like the stale-asset suite — we
 * execute it inside a `node:vm` sandbox with a minimal fake DOM.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

// Read the checked-out asset directly: `CANVAS_BRIDGE_PATH` honours a
// `CANVAS_BRIDGE_DIR` override, so on a machine running the packaged app it
// would point at the installed copy rather than this branch.
const BRIDGE_SOURCE = readFileSync(
  fileURLToPath(new URL('../../static/canvas-bridge.js', import.meta.url)),
  'utf-8',
)

type Listener = (event: any) => void

interface FakeElement {
  id: string
  className: string
  textContent: string
  attrs: Record<string, string>
  children: FakeElement[]
  removed: boolean
  onclick?: () => void
  style: { setProperty: () => void; removeProperty: () => void }
  appendChild: (child: FakeElement) => FakeElement
  remove: () => void
  setAttribute: (name: string, value: string) => void
  getAttribute: (name: string) => null
  classList: { toggle: () => void; add: () => void; remove: () => void; contains: () => boolean }
}

interface Sandbox {
  posted: any[]
  selfPosted: any[]
  reloads: number
  listeners: Record<string, Listener[]>
  elements: Map<string, FakeElement>
  styles: FakeElement[]
  addBar?: FakeElement
  emit: (type: string, event: any) => void
  emitBridgeEvent: (payload: any) => void
  startSSE: () => void
  reloadEvent: () => void
}

function makeElement(): FakeElement {
  const el: FakeElement = {
    id: '',
    className: '',
    textContent: '',
    attrs: {},
    children: [],
    removed: false,
    style: { setProperty: () => {}, removeProperty: () => {} },
    appendChild(child) {
      this.children.push(child)
      return child
    },
    remove() {
      this.removed = true
      registry?.delete(this.id)
    },
    setAttribute(name, value) {
      this.attrs[name] = value
    },
    getAttribute() {
      return null
    },
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
  }
  return el
}

let registry: Map<string, FakeElement> | undefined

function loadBridge(options: { topLevel?: boolean; hostFlag?: boolean } = {}): Sandbox {
  const posted: any[] = []
  const selfPosted: any[] = []
  let reloads = 0
  const listeners: Record<string, Listener[]> = {}
  const elements = new Map<string, FakeElement>()
  const styles: FakeElement[] = []
  registry = elements

  const documentBody = makeElement()
  const documentHead = makeElement()
  const originalAppendBody = documentBody.appendChild.bind(documentBody)
  documentBody.appendChild = (child: FakeElement) => {
    if (child.id) elements.set(child.id, child)
    return originalAppendBody(child)
  }
  documentHead.appendChild = (child: FakeElement) => {
    styles.push(child)
    return child
  }

  const fakeDocument = {
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: () => makeElement(),
    querySelector: () => null,
    styleSheets: [] as any[],
    head: documentHead,
    documentElement: makeElement(),
    body: documentBody,
  }

  let sse: { onmessage?: (e: any) => void; onopen?: () => void; onerror?: () => void } | null = null
  class FakeEventSource {
    onmessage?: (e: any) => void
    onopen?: () => void
    onerror?: () => void
    constructor() {
      sse = this
    }
    close() {}
  }

  const sandbox: any = {
    document: fakeDocument,
    EventSource: FakeEventSource,
    console,
    setTimeout: () => 0,
    location: {
      pathname: '/dashboard',
      search: '?tab=1',
      hash: '#top',
      reload: () => {
        reloads++
      },
    },
    addEventListener: (type: string, cb: Listener) => {
      listeners[type] = listeners[type] || []
      listeners[type].push(cb)
    },
    postMessage: (msg: any) => {
      selfPosted.push(msg)
    },
    history: { pushState() {}, replaceState() {} },
  }
  if (options.hostFlag) sandbox.__shogoCanvasHostDrawsUpdateBar = true
  if (options.topLevel) {
    sandbox.parent = sandbox
  } else {
    sandbox.parent = {
      postMessage: (msg: any) => {
        posted.push(msg)
      },
    }
  }
  sandbox.window = sandbox

  const context = vm.createContext(sandbox)
  vm.runInContext(BRIDGE_SOURCE, context)

  return {
    posted,
    selfPosted,
    get reloads() {
      return reloads
    },
    listeners,
    elements,
    styles,
    get addBar() {
      return elements.get('__shogo-update-toast')
    },
    emit(type, event) {
      for (const cb of listeners[type] ?? []) cb(event)
    },
    emitBridgeEvent(payload) {
      for (const cb of listeners['message'] ?? []) cb({ data: payload })
    },
    startSSE() {
      sse?.onmessage?.({ data: JSON.stringify({ type: 'init' }) })
    },
    reloadEvent() {
      sse?.onmessage?.({ data: JSON.stringify({ type: 'reload' }) })
    },
  }
}

function barStyles(bridge: Sandbox): string {
  return bridge.styles.map((s) => s.textContent).join('\n')
}

describe('canvas-bridge update bar — host draws it', () => {
  test('an acked host gets canvas-update-available and no in-document bar', () => {
    const bridge = loadBridge()
    bridge.emitBridgeEvent({ type: 'canvas-host', updateBar: true })
    bridge.startSSE()

    bridge.reloadEvent()

    expect(bridge.posted).toContainEqual({ type: 'canvas-update-available' })
    expect(bridge.addBar).toBeUndefined()
    expect(barStyles(bridge)).not.toContain('rgb(226 121 39)')
  })

  test('the pre-set host flag (native WebView injection) also suppresses the bar', () => {
    const bridge = loadBridge({ hostFlag: true })
    bridge.startSSE()

    bridge.reloadEvent()

    expect(bridge.posted).toContainEqual({ type: 'canvas-update-available' })
    expect(bridge.addBar).toBeUndefined()
  })

  test('a reload that lands before the host ack is handed over, not lost', () => {
    const bridge = loadBridge()
    bridge.startSSE()

    // No ack yet → the fallback bar is drawn.
    bridge.reloadEvent()
    expect(bridge.addBar).toBeDefined()

    // The host acks late: it takes the update over and the fallback bar goes
    // away, so exactly one bar is ever visible.
    bridge.emitBridgeEvent({ type: 'canvas-host', updateBar: true })

    expect(bridge.addBar).toBeUndefined()
    expect(bridge.posted).toContainEqual({ type: 'canvas-update-available' })

    // A second rebuild now goes straight to the host, still with no DOM bar.
    bridge.reloadEvent()
    expect(bridge.addBar).toBeUndefined()
    expect(bridge.posted.filter((m) => m.type === 'canvas-update-available').length).toBe(2)
  })
})

describe('canvas-bridge update bar — no host (standalone tab)', () => {
  test('draws one slim full-width bar pinned to the top, not a floating pill', () => {
    const bridge = loadBridge({ topLevel: true })
    bridge.startSSE()

    bridge.reloadEvent()

    const bar = bridge.addBar
    expect(bar).toBeDefined()
    expect(bar!.id).toBe('__shogo-update-toast')
    const labels = bar!.children.map((c) => c.textContent)
    expect(labels).toContain('Update available')
    expect(labels).toContain('Refresh')
    expect(labels).toContain('\u00d7')

    const css = barStyles(bridge)
    expect(css).toContain('top: 0')
    expect(css).toContain('left: 0')
    expect(css).toContain('right: 0')
    expect(css).toContain('rgb(226 121 39)')
    // The old overlay: bottom-anchored pill with a rotating conic-gradient
    // border and a pulsing glow.
    expect(css).not.toContain('bottom: 16px')
    expect(css).not.toContain('conic-gradient')
    expect(css).not.toContain('@property')
    expect(css).not.toContain('pulse-glow')
    expect(css).not.toContain('border-radius: 999px')
  })

  test('a second reload event does not stack a second bar', () => {
    const bridge = loadBridge({ topLevel: true })
    bridge.startSSE()

    bridge.reloadEvent()
    bridge.reloadEvent()

    expect(bridge.styles.filter((s) => s.textContent.includes('rgb(226 121 39)')).length).toBe(1)
  })

  test('the bar is only drawn after the SSE init event (no lost/duplicate updates)', () => {
    const bridge = loadBridge({ topLevel: true })

    bridge.reloadEvent()
    expect(bridge.addBar).toBeUndefined()

    bridge.startSSE()
    bridge.reloadEvent()
    expect(bridge.addBar).toBeDefined()
  })
})

describe('canvas-bridge reload message', () => {
  test('canvas-reload from the host reloads on the current route', () => {
    const bridge = loadBridge()
    expect(bridge.reloads).toBe(0)

    bridge.emitBridgeEvent({ type: 'canvas-reload' })

    expect(bridge.reloads).toBe(1)
  })
})
