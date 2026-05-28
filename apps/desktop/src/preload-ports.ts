// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Preload-side wiring for the Ports tab.
 *
 * Exposes `window.shogoDesktopPorts` to the renderer. The renderer's
 * `PortsPanel.tsx` consumes this bridge through the `ShogoDesktopPortsBridge`
 * interface declared in `apps/mobile/types/shogo-desktop-ports.d.ts`.
 *
 * Data plane:
 *   - subscribe() opens the subscription on the main side; updates arrive
 *     via the 'shogo:ports:list' ipcRenderer event (or 'shogo:ports:unsupported'
 *     on platforms without lsof).
 *   - unsubscribe() closes it server-side AND tears down our local listeners.
 *
 * The bridge multiplexes multiple consumers on top of a single main-process
 * subscription, so e.g. a debug Inspector and the Ports tab can both observe
 * the same poll cadence without doubling lsof calls.
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { PortEntry } from './ipc/lsof-parser'

const CH = {
  subscribe:   'shogo:ports:subscribe',
  unsubscribe: 'shogo:ports:unsubscribe',
  open:        'shogo:ports:open',
  kill:        'shogo:ports:kill',
  cmdline:     'shogo:ports:cmdline',
  list:        'shogo:ports:list',
  unsupported: 'shogo:ports:unsupported',
} as const

interface ListMessage {
  ports: PortEntry[]
  newKeys: string[]
}

type ListListener = (msg: ListMessage) => void
type UnsupportedListener = () => void

const listListeners = new Set<ListListener>()
const unsupportedListeners = new Set<UnsupportedListener>()

ipcRenderer.on(CH.list, (_e, msg: ListMessage) => {
  for (const cb of [...listListeners]) {
    try { cb(msg) } catch { /* swallow — one bad listener shouldn't break the others */ }
  }
})
ipcRenderer.on(CH.unsupported, () => {
  for (const cb of [...unsupportedListeners]) {
    try { cb() } catch { /* swallow */ }
  }
})

const bridge = {
  /**
   * Start receiving port-list updates. Returns an unsubscribe handle.
   *
   * The bridge ref-counts subscriptions on this side — only the first call
   * actually opens a main-side subscription, and only the last unsubscribe
   * closes it. That way two consumers can subscribe independently without
   * stepping on each other.
   */
  async subscribe(opts: {
    onList(msg: ListMessage): void
    onUnsupported(): void
  }): Promise<() => Promise<void>> {
    listListeners.add(opts.onList)
    unsupportedListeners.add(opts.onUnsupported)
    const wasFirst = listListeners.size === 1
    if (wasFirst) {
      await ipcRenderer.invoke(CH.subscribe)
    }
    let unsubscribed = false
    return async () => {
      if (unsubscribed) return
      unsubscribed = true
      listListeners.delete(opts.onList)
      unsupportedListeners.delete(opts.onUnsupported)
      if (listListeners.size === 0) {
        await ipcRenderer.invoke(CH.unsubscribe)
      }
    }
  },

  async open(port: number): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke(CH.open, port) as Promise<{ ok: boolean; error?: string }>
  },

  async kill(pid: number): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke(CH.kill, pid) as Promise<{ ok: boolean; error?: string }>
  },

  async getCommandLine(pid: number): Promise<{ ok: boolean; commandLine?: string; error?: string }> {
    return ipcRenderer.invoke(CH.cmdline, pid) as Promise<{ ok: boolean; commandLine?: string; error?: string }>
  },
}

export type ShogoDesktopPortsBridge = typeof bridge

export function exposeShogoDesktopPortsBridge(): void {
  contextBridge.exposeInMainWorld('shogoDesktopPorts', bridge)
}
