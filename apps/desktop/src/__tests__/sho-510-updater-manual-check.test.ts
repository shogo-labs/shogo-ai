// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-510, the main-process half.
 *
 * AC4: an explicit "Check for updates" from Settings → Updates must override a
 * "not now" the user gave the banner earlier in the session — otherwise the
 * page goes blank with no way back. The 10-minute background probe must keep
 * respecting the dismissal, or the banner the user closed reappears on its own.
 *
 * AC3: a download that fails has to say why on the next status broadcast, so
 * the page and the banner can show the reason beside the retry.
 *
 * `updater.ts` talks to Electron directly, so `electron` is mocked once before
 * the dynamic import and the IPC handlers it registers are driven here.
 */
import { describe, expect, it, mock } from 'bun:test'
import { tmpdir } from 'os'

type Handler = (event: unknown, ...args: any[]) => any

const handlers = new Map<string, Handler>()
const updaterEvents = new Map<string, (...args: any[]) => void>()
const sent: Array<{ channel: string; payload: any }> = []
const intervals: Array<() => void> = []
let feed: { name?: string; url?: string } | null = null

mock.module('electron', () => ({
  app: {
    getVersion: () => '2.6.0',
    getPath: () => tmpdir(),
    on: () => {},
    once: () => {},
  },
  autoUpdater: {
    setFeedURL: () => {},
    checkForUpdates: () => {},
    quitAndInstall: () => {},
    on: (event: string, cb: (...args: any[]) => void) => {
      updaterEvents.set(event, cb)
    },
  },
  ipcMain: {
    handle: (channel: string, cb: Handler) => {
      handlers.set(channel, cb)
    },
  },
  BrowserWindow: {
    getAllWindows: () => [
      { webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } },
    ],
  },
  net: {
    fetch: async () =>
      feed
        ? { status: 200, ok: true, json: async () => feed }
        : { status: 204, ok: false, json: async () => null },
  },
}))

mock.module('../local-server', () => ({
  getApiUrl: () => 'http://127.0.0.1:0',
}))

mock.module('../live-activity', () => ({
  NO_LIVE_ACTIVITY: { agentRuns: 0, backgroundCommands: 0 },
  liveActivityTotal: (activity: any) => (activity?.agentRuns ?? 0) + (activity?.backgroundCommands ?? 0),
  describeLiveActivity: () => 'Nothing is working',
  fetchLiveActivity: async () => null,
  setApiDrain: async () => true,
}))

// The updater only initialises on macOS and Windows. Pin the platform so this
// exercises the handlers on any CI host.
Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })

const realSetInterval = globalThis.setInterval
;(globalThis as { setInterval?: unknown }).setInterval = ((fn: () => void) => {
  intervals.push(fn)
  return 0
}) as unknown as typeof setInterval

const { initAutoUpdater } = await import('../updater')
initAutoUpdater()

;(globalThis as { setInterval?: unknown }).setInterval = realSetInterval

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const invoke = async (channel: string, ...args: unknown[]) => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`no handler registered for ${channel}`)
  const result = await handler(null, ...args)
  return result
}

const statusBroadcasts = () =>
  sent.filter((entry) => entry.channel === 'desktop-update-status').map((entry) => entry.payload)

const lastStatus = () => statusBroadcasts().at(-1)

describe('manual update check vs session dismissal', () => {
  it('brings a dismissed version back, while the background probe stays quiet', async () => {
    feed = { name: '2.7.0' }

    // The banner offers it…
    await invoke('check-for-updates')
    await settle()
    expect(lastStatus()).toMatchObject({ status: 'available', availableVersion: '2.7.0', error: null })

    // …the user closes the banner.
    await invoke('dismiss-update')
    expect(lastStatus()).toMatchObject({ status: 'idle' })

    // The 10-minute background probe must not re-open what they closed.
    const before = statusBroadcasts().length
    const backgroundProbe = intervals[0]
    expect(backgroundProbe).toBeDefined()
    backgroundProbe()
    await settle()
    expect(statusBroadcasts().length).toBe(before)

    // Asking explicitly on Settings → Updates overrides the dismissal.
    await invoke('check-for-updates')
    await settle()
    expect(lastStatus()).toMatchObject({ status: 'available', availableVersion: '2.7.0', error: null })
  })

  it('reports why a download failed and offers it again', async () => {
    feed = { name: '2.7.0' }
    await invoke('check-for-updates')
    await settle()
    expect(lastStatus()).toMatchObject({ status: 'available' })

    await invoke('download-update')
    // Squirrel's checkForUpdates() is what starts the download; the events it
    // emits are replayed here.
    updaterEvents.get('update-available')?.()
    expect(lastStatus()).toMatchObject({ status: 'downloading', error: null })

    updaterEvents.get('error')?.(new Error('ENOTFOUND update.electronjs.org'))
    await settle()

    expect(lastStatus()).toMatchObject({
      status: 'available',
      availableVersion: '2.7.0',
      error: 'Could not reach the update server — check your connection and try again.',
    })
    // Still offerable: the download can be retried instead of being stuck.
    expect(await invoke('download-update')).toEqual({ ok: true })
  })
})
