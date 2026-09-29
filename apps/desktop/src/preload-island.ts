// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Runs sandboxed: only `electron` may be required at runtime, so every
// local import here must stay type-only.

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IslandBridge, IslandLayout, IslandSnapshot } from './island-protocol'

const bridge: IslandBridge = {
  onSnapshot: (callback) => {
    ipcRenderer.on('island:snapshot', (_event, snapshot: IslandSnapshot) => callback(snapshot))
  },
  onLayout: (callback) => {
    ipcRenderer.on('island:layout', (_event, layout: IslandLayout) => callback(layout))
  },
  onOpenCompose: (callback) => {
    ipcRenderer.on('island:open-compose', () => callback())
  },
  sendAction: (action) => ipcRenderer.invoke('island:action', action),
  setMode: (mode) => ipcRenderer.send('island:mode', mode),
  setInteractive: (interactive) => ipcRenderer.send('island:interactive', interactive),
  getPathForFile: (file) => webUtils.getPathForFile(file),
}

contextBridge.exposeInMainWorld('shogoIsland', bridge)
