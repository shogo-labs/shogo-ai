// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { contextBridge, ipcRenderer } from 'electron'

const portArg = process.argv.find((a) => a.startsWith('--api-port='))
const apiPort = portArg ? portArg.split('=')[1] : '39100'

contextBridge.exposeInMainWorld('shogoDesktop', {
  platform: process.platform,
  isDesktop: true,
  apiUrl: `http://localhost:${apiPort}`,
  getAppMode: () => ipcRenderer.invoke('get-app-mode'),
  getAppConfig: () => ipcRenderer.invoke('get-app-config'),
  setAppMode: (mode: 'local' | 'cloud') => ipcRenderer.invoke('set-app-mode', mode),
})
