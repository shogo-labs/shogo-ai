// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// `window.shogoHuddleHost`, exposed only in the huddle window
// (`--shogo-huddle`). That window loads the app's `/huddle` route, which runs
// the LiveKit room and reports its state back to the app window. The app
// window's side of the bridge is `window.shogoDesktop.huddle` (see preload.ts).

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { HUDDLE_WINDOW_ARG, type HuddleCommand, type HuddleJoinRequest, type HuddleWindowMode } from './huddle-protocol'

export { HUDDLE_WINDOW_ARG }

function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, value: T) => callback(value)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

export function exposeShogoHuddleHostBridge(): void {
  if (!process.argv.includes(HUDDLE_WINDOW_ARG)) return
  contextBridge.exposeInMainWorld('shogoHuddleHost', {
    /** The call to join, sent once the route has loaded (and again if the app asks for another). */
    onJoin: (callback: (request: HuddleJoinRequest) => void) => subscribe<HuddleJoinRequest>('huddle:join', callback),
    onCommand: (callback: (command: HuddleCommand) => void) => subscribe<HuddleCommand>('huddle:command', callback),
    requestJoin: () => ipcRenderer.send('huddle:host-ready'),
    sendState: (snapshot: unknown) => ipcRenderer.send('huddle:host-state', snapshot),
    setMode: (mode: HuddleWindowMode) => ipcRenderer.send('huddle:host-mode', mode),
    /** The call is over; close this window. */
    close: () => ipcRenderer.send('huddle:host-close'),
    /** Focus the app window (e.g. "Open conversation"). */
    showApp: (path?: string) => ipcRenderer.send('huddle:host-show-app', path),
  })
}
