// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Repro + regression coverage for the "blank white page after rebuild"
 * production pain point (AI Insights digest, 27 of the last 31 days —
 * see the 2026-09-15..21 painPoints for "Project Ready" / stale-cache /
 * blank-page reports).
 *
 * Root cause: `canvas-bridge.js`'s capture-phase `error` listener already
 * detects a failed `<script src="...">` load (e.g. a hashed bundle an
 * atomic rebuild already deleted) and reports it to the parent frame — but
 * an EXTERNAL `*.preview.shogo.ai` tab (not embedded in an iframe) never
 * sees that postMessage, so the user is left staring at a blank page with
 * no recovery. This suite pins the fix: a one-shot, sessionStorage-guarded
 * `location.reload()` for content-hashed asset failures, so the tab
 * self-heals on the next load (which now serves the current `index.html`
 * pointing at the current hashes) without looping forever if the asset is
 * still missing after a reload.
 *
 * `canvas-bridge.js` is plain browser JS (no module system, referenced as
 * `window`/`document`/`location` globals — see file header). We execute it
 * inside a `node:vm` sandbox with a minimal fake DOM rather than importing
 * it, mirroring how a real iframe would load it as a classic script.
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { CANVAS_BRIDGE_PATH } from '../canvas-bridge'

const BRIDGE_SOURCE = readFileSync(CANVAS_BRIDGE_PATH, 'utf-8')

type Listener = (event: any) => void

interface Sandbox {
  posted: any[]
  reloads: number
  listeners: Record<string, Listener[]>
  sessionStore: Map<string, string>
}

function makeFakeElement(): any {
  return {
    id: '',
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    style: { setProperty() {}, removeProperty() {} },
    appendChild() {},
    remove() {},
    setAttribute() {},
    getAttribute: () => null,
    textContent: '',
  }
}

/**
 * Load `canvas-bridge.js` into a fresh, minimal `node:vm` sandbox that
 * stands in for an iframe's global scope. `window` is the sandbox itself
 * (as in a real browser, `window === globalThis`), and `window.parent` is a
 * distinct object so the script's `window.parent !== window` iframe checks
 * behave as if embedded. `setTimeout` is a no-op so the SSE
 * reconnect-with-backoff loop (which fires because `EventSource` isn't
 * defined in this sandbox) never schedules real timers that could leak
 * across tests.
 */
function loadBridgeInSandbox(): Sandbox {
  const posted: any[] = []
  let reloads = 0
  const listeners: Record<string, Listener[]> = {}
  const sessionStore = new Map<string, string>()

  const fakeDocument = {
    getElementById: () => null,
    createElement: () => makeFakeElement(),
    querySelector: () => null,
    styleSheets: [] as any[],
    head: makeFakeElement(),
    documentElement: makeFakeElement(),
    body: makeFakeElement(),
  }

  const fakeSessionStorage = {
    getItem: (k: string) => (sessionStore.has(k) ? sessionStore.get(k)! : null),
    setItem: (k: string, v: string) => { sessionStore.set(k, String(v)) },
    removeItem: (k: string) => { sessionStore.delete(k) },
  }

  const sandbox: any = {
    document: fakeDocument,
    sessionStorage: fakeSessionStorage,
    console,
    setTimeout: () => 0, // no-op: prevents SSE retry-backoff timers from leaking
    location: {
      pathname: '/', search: '', hash: '',
      reload: () => { reloads++ },
    },
    parent: {
      postMessage: (msg: any) => { posted.push(msg) },
    },
    addEventListener: (type: string, cb: Listener) => {
      listeners[type] = listeners[type] || []
      listeners[type].push(cb)
    },
  }
  sandbox.window = sandbox // window === globalThis, as in a real browser

  const context = vm.createContext(sandbox)
  vm.runInContext(BRIDGE_SOURCE, context)

  return {
    get posted() { return posted },
    get reloads() { return reloads },
    listeners,
    sessionStore,
  } as any
}

function dispatchScriptLoadError(sandbox: ReturnType<typeof loadBridgeInSandbox>, src: string) {
  const errorListeners = sandbox.listeners['error']
  expect(errorListeners?.length).toBeGreaterThan(0)
  for (const cb of errorListeners!) {
    cb({ target: { tagName: 'SCRIPT', src } })
  }
}

describe('canvas-bridge stale-asset recovery', () => {
  test('sanity: the bridge script is parseable and non-trivial', () => {
    expect(BRIDGE_SOURCE.length).toBeGreaterThan(1_000)
    expect(() => new Function(BRIDGE_SOURCE)).not.toThrow()
  })

  test('a failed content-hashed bundle load triggers exactly one auto-reload', () => {
    const sandbox = loadBridgeInSandbox()
    dispatchScriptLoadError(sandbox, '/assets/index-a1b2c3d4.js')

    // Existing behavior (must not regress): still reports to the parent.
    expect(sandbox.posted.some((m) => m.type === 'canvas-error')).toBe(true)

    // New behavior: the runtime self-heals instead of leaving the tab blank.
    expect(sandbox.reloads).toBe(1)
  })

  test('a second failure for the SAME hashed asset does not reload again (no loop)', () => {
    const sandbox = loadBridgeInSandbox()
    dispatchScriptLoadError(sandbox, '/assets/index-a1b2c3d4.js')
    expect(sandbox.reloads).toBe(1)

    // Simulate the reload not having happened yet in-process (same page,
    // same sessionStorage) and the identical asset failing again — e.g. the
    // deploy is genuinely broken, not just a stale cache.
    dispatchScriptLoadError(sandbox, '/assets/index-a1b2c3d4.js')
    expect(sandbox.reloads).toBe(1)
  })

  test('a failure for a DIFFERENT hashed asset after a prior reload attempt still reloads once', () => {
    const sandbox = loadBridgeInSandbox()
    dispatchScriptLoadError(sandbox, '/assets/index-a1b2c3d4.js')
    expect(sandbox.reloads).toBe(1)

    dispatchScriptLoadError(sandbox, '/assets/vendor-9f8e7d6c.js')
    expect(sandbox.reloads).toBe(2)
  })

  test('a failure for a non-hashed resource (e.g. a plain favicon or third-party image) does not trigger a reload', () => {
    const sandbox = loadBridgeInSandbox()
    dispatchScriptLoadError(sandbox, '/favicon.ico')
    expect(sandbox.reloads).toBe(0)
    expect(sandbox.posted.some((m) => m.type === 'canvas-error')).toBe(true)
  })

  test('a generic runtime error (no failed-element target) is reported but never reloads', () => {
    const sandbox = loadBridgeInSandbox()
    const errorListeners = sandbox.listeners['error']
    for (const cb of errorListeners!) {
      cb({ target: sandbox.window, message: 'TypeError: x is not a function', error: { stack: '' } })
    }
    expect(sandbox.reloads).toBe(0)
    expect(sandbox.posted.some((m) => m.type === 'canvas-error')).toBe(true)
  })
})
