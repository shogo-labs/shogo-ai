// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-510: the update, restart-drain and interrupted-notice subscriptions must
 * hand back a per-listener unsubscribe.
 *
 * The bug: all three exposed `remove*Listener()`, an
 * `ipcRenderer.removeAllListeners(channel)`, and Settings → Updates called
 * `removeUpdateListener()` on unmount. Opening the tab and leaving it therefore
 * cut the banner's status stream off until the app reloaded.
 *
 * What is asserted is the shape the renderer sees: each `on…` returns a
 * function, and calling it removes **only** the listener it was given.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'

type Listener = (event: unknown, payload: unknown) => void

const listeners = new Map<string, Set<Listener>>()
// The preload exposes more than one bridge (`shogoDesktop`, then the terminal
// bridge); keep them by name rather than remembering only the last one.
const exposedBridges = new Map<string, Record<string, any>>()

function listenersFor(channel: string): Set<Listener> {
  let set = listeners.get(channel)
  if (!set) {
    set = new Set()
    listeners.set(channel, set)
  }
  return set
}

mock.module('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: Record<string, any>) => {
      exposedBridges.set(name, api)
    },
  },
  webUtils: { getPathForFile: () => '' },
  ipcRenderer: {
    invoke: async () => ({}),
    send: () => {},
    postMessage: () => {},
    on: (channel: string, listener: Listener) => {
      listenersFor(channel).add(listener)
    },
    removeListener: (channel: string, listener: Listener) => {
      listenersFor(channel).delete(listener)
    },
    removeAllListeners: (channel: string) => {
      listenersFor(channel).clear()
    },
  },
}))

// The preload script runs in the renderer: it registers a `beforeunload`
// listener at module scope, so give it a window to attach to.
const noop = () => {}
;(globalThis as Record<string, unknown>).window = {
  addEventListener: noop,
  removeEventListener: noop,
  location: { href: 'http://localhost/' },
}

await import('../preload')

const bridge = () => exposedBridges.get('shogoDesktop') as Record<string, any>

/** Fire what the main process would send for `channel`. */
function emit(channel: string, payload: unknown): void {
  for (const listener of [...listenersFor(channel)]) listener({}, payload)
}

beforeEach(() => {
  listeners.clear()
})

describe('preload update subscriptions', () => {
  test('onUpdateStatus unsubscribes only its own listener', () => {
    const first: unknown[] = []
    const second: unknown[] = []

    const unsubscribeFirst = bridge().onUpdateStatus((data: unknown) => first.push(data))
    bridge().onUpdateStatus((data: unknown) => second.push(data))

    expect(typeof unsubscribeFirst).toBe('function')
    expect(listenersFor('desktop-update-status').size).toBe(2)

    unsubscribeFirst()

    expect(listenersFor('desktop-update-status').size).toBe(1)

    emit('desktop-update-status', { status: 'available', releaseName: null, availableVersion: '2.7.0' })

    // The other consumer still hears the broadcast — this is the regression.
    expect(first).toEqual([])
    expect(second).toEqual([
      { status: 'available', releaseName: null, availableVersion: '2.7.0' },
    ])
  })

  test('onRestartDrain and onInterruptedNotice unsubscribe only their own listener', () => {
    const drains: unknown[] = []
    const notices: unknown[] = []

    const unsubscribeDrain = bridge().onRestartDrain((data: unknown) => drains.push(data))
    const unsubscribeNotice = bridge().onInterruptedNotice((data: unknown) => notices.push(data))
    bridge().onRestartDrain(() => {})
    bridge().onInterruptedNotice(() => {})

    expect(listenersFor('desktop-restart-drain').size).toBe(2)
    expect(listenersFor('desktop-interrupted-notice').size).toBe(2)

    unsubscribeDrain()
    unsubscribeNotice()

    expect(listenersFor('desktop-restart-drain').size).toBe(1)
    expect(listenersFor('desktop-interrupted-notice').size).toBe(1)

    emit('desktop-restart-drain', { active: true, activity: { agentRuns: 2, backgroundCommands: 0 } })
    emit('desktop-interrupted-notice', { notice: 'Restarting interrupted 2 agent runs.' })

    expect(drains).toEqual([])
    expect(notices).toEqual([])
  })
})
