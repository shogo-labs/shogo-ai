// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
// Preload that installs happy-dom DOM globals onto Node/Bun's globalThis,
// so React can render components (and run effects) under `bun test`.
// Mirrors packages/sdk/src/agent/__tests__/happy-dom-setup.ts — inlined
// because @happy-dom/global-registrator is not installable in this sandbox.

import GlobalWindow from 'happy-dom/lib/window/GlobalWindow.js'

declare global {
  // eslint-disable-next-line no-var
  var __happyDomInstalled: boolean | undefined
}

if (!globalThis.__happyDomInstalled) {
  const win = new GlobalWindow()
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
    try {
      ;(globalThis as Record<string, unknown>)[key] = (win as unknown as Record<string, unknown>)[key]
    } catch {
      /* readonly — ignore */
    }
  }
  ;(globalThis as any).window = globalThis
  ;(globalThis as any).document = win.document
  ;(globalThis as any).navigator = win.navigator
  ;(globalThis as any).HTMLElement = win.HTMLElement
  ;(globalThis as any).Element = win.Element
  ;(globalThis as any).Node = win.Node
  ;(globalThis as any).Event = (globalThis as any).Event ?? win.Event
  ;(globalThis as any).CustomEvent = win.CustomEvent
  ;(globalThis as any).getComputedStyle = win.getComputedStyle.bind(win)
  ;(globalThis as any).requestAnimationFrame = win.requestAnimationFrame.bind(win)
  ;(globalThis as any).cancelAnimationFrame = win.cancelAnimationFrame.bind(win)
  globalThis.__happyDomInstalled = true
}
