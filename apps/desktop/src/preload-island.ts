// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// `window.shogoIsland`, exposed by the main preload only in the island
// window (`--shogo-island`). That window loads the app's `/island` route, so
// it also needs the rest of `window.shogoDesktop` (API URL, local mode).

import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { IslandBridge, IslandLayout, IslandMeetingState, IslandSnapshot } from './island-protocol'

export const ISLAND_WINDOW_ARG = '--shogo-island'

function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, value: T) => callback(value)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

export function exposeShogoIslandBridge(): void {
  if (!process.argv.includes(ISLAND_WINDOW_ARG)) return
  const bridge: IslandBridge = {
    onSnapshot: (callback) => subscribe<IslandSnapshot>('island:snapshot', callback),
    onLayout: (callback) => subscribe<IslandLayout>('island:layout', callback),
    onOpenCompose: (callback) => subscribe<void>('island:open-compose', () => callback()),
    onMeeting: (callback) => subscribe<IslandMeetingState>('island:meeting', callback),
    requestState: () => ipcRenderer.send('island:request-state'),
    sendAction: (action) => ipcRenderer.invoke('island:action', action),
    readFiles: (files) => ipcRenderer.invoke('island:read-files', files),
    setMode: (mode) => ipcRenderer.send('island:mode', mode),
    setInteractive: (interactive) => ipcRenderer.send('island:interactive', interactive),
    setContentHeight: (height) => ipcRenderer.send('island:content-height', height),
    getPathForFile: (file) => webUtils.getPathForFile(file),
  }
  contextBridge.exposeInMainWorld('shogoIsland', bridge)
}
