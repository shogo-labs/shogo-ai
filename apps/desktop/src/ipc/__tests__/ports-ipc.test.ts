// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the subscription / fan-out / diff logic in ports-ipc.
 *
 * We mock electron once at the top of the file (before the dynamic import
 * of ports-ipc) so this suite runs headless. The spawn-based paths (`lsof`,
 * `ps`) are NOT exercised here — they're covered by lsof-parser tests + the
 * integration verify step. What we DO cover is subscription bookkeeping,
 * because that's where the logic bugs live (first-send "newKeys" treatment,
 * fan-out across multiple webContents, cleanup on destroy, etc.).
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test'
import type { PortEntry } from '../lsof-parser'

let subscribeHandler: ((event: { sender: FakeWebContents }) => unknown) | null = null
let unsubscribeHandler: ((event: { sender: FakeWebContents }) => unknown) | null = null

mock.module('electron', () => ({
  ipcMain: {
    handle(channel: string, cb: (event: { sender: FakeWebContents }, ...args: unknown[]) => unknown) {
      if (channel === 'shogo:ports:subscribe')   subscribeHandler   = cb as never
      if (channel === 'shogo:ports:unsubscribe') unsubscribeHandler = cb as never
    },
    removeHandler() {},
  },
  shell: { openExternal: async () => true },
  BrowserWindow: class {},
}))

const portsIpcMod = await import('../ports-ipc')
const { __test: ipcTest, registerPortsIpcHandlers, disposePortsIpcHandlers } = portsIpcMod

interface FakeWebContents {
  destroyed: boolean
  sent: Array<{ channel: string; payload: unknown }>
  destroyHandlers: Array<() => void>
  isDestroyed(): boolean
  send(channel: string, payload?: unknown): void
  once(event: string, cb: () => void): void
  destroy(): void
}

function makeWebContents(): FakeWebContents {
  const wc: FakeWebContents = {
    destroyed: false,
    sent: [],
    destroyHandlers: [],
    isDestroyed() { return wc.destroyed },
    send(channel, payload) { wc.sent.push({ channel, payload }) },
    once(event, cb) {
      if (event === 'destroyed') wc.destroyHandlers.push(cb)
    },
    destroy() {
      wc.destroyed = true
      for (const cb of wc.destroyHandlers) cb()
    },
  }
  return wc
}

function subscribe(wc: FakeWebContents): void {
  if (!subscribeHandler) throw new Error('subscribe handler not registered — call registerPortsIpcHandlers() first')
  void subscribeHandler({ sender: wc })
}

function unsubscribe(wc: FakeWebContents): void {
  if (!unsubscribeHandler) throw new Error('unsubscribe handler not registered')
  void unsubscribeHandler({ sender: wc })
}

const PORT_3000: PortEntry = { port: 3000, command: 'node', pid: 100, address: '*', type: 'IPv4' }
const PORT_5432: PortEntry = { port: 5432, command: 'postgres', pid: 200, address: '127.0.0.1', type: 'IPv4' }
const PORT_8080: PortEntry = { port: 8080, command: 'nginx', pid: 300, address: '*', type: 'IPv4' }

describe('ports-ipc subscriber flow', () => {
  beforeEach(() => {
    ipcTest.reset()
    subscribeHandler = null
    unsubscribeHandler = null
    registerPortsIpcHandlers()
  })

  it('starts polling on first subscribe, stops on last unsubscribe via destroy', () => {
    expect(ipcTest.pollingActive).toBe(false)
    const wc = makeWebContents()
    subscribe(wc)
    expect(ipcTest.subscriberCount).toBe(1)
    expect(ipcTest.pollingActive).toBe(true)

    wc.destroy()
    expect(ipcTest.subscriberCount).toBe(0)
    expect(ipcTest.pollingActive).toBe(false)
  })

  it('explicit unsubscribe also stops polling', () => {
    const wc = makeWebContents()
    subscribe(wc)
    expect(ipcTest.pollingActive).toBe(true)
    unsubscribe(wc)
    expect(ipcTest.subscriberCount).toBe(0)
    expect(ipcTest.pollingActive).toBe(false)
  })

  it('delivers full list on first push with no newKeys', () => {
    const wc = makeWebContents()
    subscribe(wc)
    wc.sent.length = 0
    ipcTest.pushScanResultForTest([PORT_3000, PORT_5432])

    const listMsgs = wc.sent.filter((m) => m.channel === 'shogo:ports:list')
    expect(listMsgs).toHaveLength(1)
    const payload = listMsgs[0]!.payload as { ports: PortEntry[]; newKeys: string[] }
    expect(payload.ports).toEqual([PORT_3000, PORT_5432])
    expect(payload.newKeys).toEqual([])
  })

  it('marks rows added in the next push as new', () => {
    const wc = makeWebContents()
    subscribe(wc)
    wc.sent.length = 0
    ipcTest.pushScanResultForTest([PORT_3000])
    ipcTest.pushScanResultForTest([PORT_3000, PORT_8080])

    const second = wc.sent.filter((m) => m.channel === 'shogo:ports:list')[1]
    const payload = second!.payload as { ports: PortEntry[]; newKeys: string[] }
    expect(payload.ports).toHaveLength(2)
    expect(payload.newKeys).toEqual(['8080:300'])
  })

  it('does not double-mark a row as new if it stays around', () => {
    const wc = makeWebContents()
    subscribe(wc)
    wc.sent.length = 0
    ipcTest.pushScanResultForTest([PORT_3000])
    ipcTest.pushScanResultForTest([PORT_3000, PORT_8080])
    ipcTest.pushScanResultForTest([PORT_3000, PORT_8080])

    const third = wc.sent.filter((m) => m.channel === 'shogo:ports:list')[2]
    const payload = third!.payload as { ports: PortEntry[]; newKeys: string[] }
    expect(payload.newKeys).toEqual([])
  })

  it('does not deliver to destroyed webContents', () => {
    const wc = makeWebContents()
    subscribe(wc)
    wc.destroy()
    wc.sent.length = 0
    ipcTest.pushScanResultForTest([PORT_3000])
    expect(wc.sent).toEqual([])
  })

  it('fans out to multiple subscribers, each with their own first-send treatment', () => {
    const a = makeWebContents()
    subscribe(a)
    ipcTest.pushScanResultForTest([PORT_3000])
    a.sent.length = 0

    const b = makeWebContents()
    subscribe(b)
    ipcTest.pushScanResultForTest([PORT_3000, PORT_8080])

    const aLatest = a.sent.filter((m) => m.channel === 'shogo:ports:list').pop()
    const bLatest = b.sent.filter((m) => m.channel === 'shogo:ports:list').pop()
    const aPayload = aLatest!.payload as { newKeys: string[] }
    const bPayload = bLatest!.payload as { newKeys: string[] }
    expect(aPayload.newKeys).toEqual(['8080:300'])
    expect(bPayload.newKeys).toEqual([])
  })

  it('reports unsupported once and stops polling', () => {
    const wc = makeWebContents()
    subscribe(wc)
    wc.sent.length = 0
    ipcTest.pushScanResultForTest(null)
    const events = wc.sent.map((m) => m.channel)
    expect(events).toContain('shogo:ports:unsupported')
    expect(ipcTest.pollingActive).toBe(false)
  })

  it('tells late subscribers about unsupported immediately without restarting polling', () => {
    const a = makeWebContents()
    subscribe(a)
    ipcTest.pushScanResultForTest(null)
    expect(ipcTest.pollingActive).toBe(false)

    const b = makeWebContents()
    subscribe(b)
    const events = b.sent.map((m) => m.channel)
    expect(events).toContain('shogo:ports:unsupported')
    expect(ipcTest.pollingActive).toBe(false)
  })
})

describe('ports-ipc lifecycle', () => {
  it('dispose() is idempotent and clears state', () => {
    ipcTest.reset()
    registerPortsIpcHandlers()
    const wc = makeWebContents()
    subscribe(wc)
    expect(ipcTest.subscriberCount).toBe(1)

    disposePortsIpcHandlers()
    expect(ipcTest.subscriberCount).toBe(0)
    expect(ipcTest.pollingActive).toBe(false)

    expect(() => disposePortsIpcHandlers()).not.toThrow()
  })
})
