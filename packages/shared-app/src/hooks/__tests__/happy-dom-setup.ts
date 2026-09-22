// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
// Preload that installs happy-dom DOM globals onto Node/Bun's globalThis,
// so React + @testing-library/react can render hooks under `bun test`.
// Mirrors `packages/sdk/src/agent/__tests__/happy-dom-setup.ts` — kept as a
// separate copy (rather than a shared import) so this package doesn't take
// on a cross-package test-only dependency on `@shogo-ai/sdk`'s test internals.

import GlobalWindow from 'happy-dom/lib/window/GlobalWindow.js'

declare global {
  // eslint-disable-next-line no-var
  var __happyDomInstalled: boolean | undefined
}

const previousGlobals = new Map<string, { hadOwn: boolean; value: unknown }>()
const globalObject = globalThis as Record<string, unknown>

function rememberGlobal(key: string): void {
  if (!previousGlobals.has(key)) {
    previousGlobals.set(key, {
      hadOwn: Object.prototype.hasOwnProperty.call(globalThis, key),
      value: globalObject[key],
    })
  }
}

/**
 * Restore the host globals after the hook tests complete. The shared-app
 * suite runs multiple test files in one Bun process; leaving a synthetic
 * `window` behind changes the behavior of unrelated tests that intentionally
 * branch on whether a browser global exists.
 */
export function restoreHappyDom(): void {
  for (const [key, previous] of previousGlobals) {
    if (previous.hadOwn) {
      globalObject[key] = previous.value
    } else {
      delete globalObject[key]
    }
  }
  previousGlobals.clear()
}

if (!globalThis.__happyDomInstalled) {
  const win = new GlobalWindow()
  // Mirror DOM-ish keys onto globalThis. Skip keys that node already owns
  // (Array, Map, Promise, etc.) or that conflict with bun:test.
  const skip = new Set<string>([
    'console', 'process', 'Buffer', 'global', 'globalThis',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    'setImmediate', 'clearImmediate', 'queueMicrotask',
    'fetch', 'Request', 'Response', 'Headers', 'FormData', 'URL', 'URLSearchParams',
    'AbortController', 'AbortSignal', 'TextEncoder', 'TextDecoder',
    'crypto', 'performance',
  ])
  for (const key of Reflect.ownKeys(win) as string[]) {
    if (typeof key !== 'string') continue
    if (skip.has(key)) continue
    if (key in globalThis) continue
    rememberGlobal(key)
    try {
      globalObject[key] = (win as unknown as Record<string, unknown>)[key]
    } catch {
      /* readonly — ignore */
    }
  }
  // Always re-bind these (React expects window === globalThis-ish)
  for (const [key, value] of [
    ['window', globalThis],
    ['document', win.document],
    ['navigator', win.navigator],
    ['HTMLElement', win.HTMLElement],
    ['Element', win.Element],
    ['Node', win.Node],
    ['Event', (globalThis as any).Event ?? win.Event],
    ['CustomEvent', win.CustomEvent],
    ['getComputedStyle', win.getComputedStyle.bind(win)],
    ['requestAnimationFrame', win.requestAnimationFrame.bind(win)],
    ['cancelAnimationFrame', win.cancelAnimationFrame.bind(win)],
  ] as const) {
    rememberGlobal(key)
    globalObject[key] = value
  }
  rememberGlobal('__happyDomInstalled')
  globalThis.__happyDomInstalled = true
}
