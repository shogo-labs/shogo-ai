// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { registerLazyChannels, type LazyIpcHost } from '../lazy-ipc'

function fakeIpc(): LazyIpcHost & { handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown> } {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  return {
    handlers,
    handle(channel, listener) {
      handlers.set(channel, listener)
    },
    removeHandler(channel) {
      handlers.delete(channel)
    },
  }
}

describe('registerLazyChannels', () => {
  test('loads the module on first call and forwards to the real handler', async () => {
    const ipc = fakeIpc()
    let loads = 0
    const real = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    registerLazyChannels(ipc, ['ext:one'], async () => {
      loads += 1
      real.set('ext:one', () => 'ok')
      ipc.handle('ext:one', real.get('ext:one')!)
      return { call: (channel, event, args) => real.get(channel)!(event, ...args) }
    })
    const stub = ipc.handlers.get('ext:one')!
    await expect(stub({}, 'a')).resolves.toBe('ok')
    // The real module replaces the stub, so the second call may be synchronous.
    expect(await ipc.handlers.get('ext:one')!({}, 'b')).toBe('ok')
    expect(loads).toBe(1)
  })

  test('dispose drops channels and ignores a load that finishes later', async () => {
    const ipc = fakeIpc()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const lazy = registerLazyChannels(ipc, ['ext:one'], async () => {
      await gate
      ipc.handle('ext:one', () => 'late')
      return { call: () => 'late' }
    })
    const pending = ipc.handlers.get('ext:one')!({})
    lazy.dispose()
    release()
    await pending
    expect(ipc.handlers.has('ext:one')).toBe(false)
  })
})
