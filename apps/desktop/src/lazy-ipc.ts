// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * IPC channels whose implementation modules stay unloaded until the first
 * call. `register` must install the real handlers (and a `call` that can
 * serve the in-flight invocation, because Electron does not re-enter the
 * handler that `ipcMain.handle` just replaced).
 */
export interface LazyIpcHost {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
  removeHandler(channel: string): void
}

export interface LazyIpcModule {
  call(channel: string, event: unknown, args: unknown[]): unknown
}

export function registerLazyChannels(
  ipc: LazyIpcHost,
  channels: readonly string[],
  load: () => Promise<LazyIpcModule>,
): { dispose(): void } {
  let disposed = false
  let pending: Promise<LazyIpcModule> | null = null
  const ensure = () => {
    pending ??= load()
    return pending
  }

  for (const channel of channels) {
    ipc.handle(channel, async (event, ...args) => {
      if (disposed) return
      const mod = await ensure()
      if (disposed) {
        for (const name of channels) ipc.removeHandler(name)
        return
      }
      return mod.call(channel, event, args)
    })
  }

  return {
    dispose() {
      disposed = true
      for (const channel of channels) ipc.removeHandler(channel)
    },
  }
}
