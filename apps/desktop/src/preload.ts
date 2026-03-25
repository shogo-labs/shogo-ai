// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('shogoDesktop', {
  platform: process.platform,
  isDesktop: true,
  getAppMode: () => ipcRenderer.invoke('get-app-mode'),
  getAppConfig: () => ipcRenderer.invoke('get-app-config'),
  setAppMode: (mode: 'local' | 'cloud') => ipcRenderer.invoke('set-app-mode', mode),
})
