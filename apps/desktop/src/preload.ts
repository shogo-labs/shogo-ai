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
  getVMImageStatus: () => ipcRenderer.invoke('get-vm-image-status'),
  downloadVMImages: () => ipcRenderer.invoke('download-vm-images'),
  skipVMDownload: () => ipcRenderer.invoke('skip-vm-download'),
  onVMImageNeeded: (callback: (data: { downloadUrl: string; imageDir: string }) => void) => {
    ipcRenderer.on('vm-image-needed', (_event, data) => callback(data))
  },
  onVMImageDownloadProgress: (callback: (progress: { bytesDownloaded: number; totalBytes: number; percent: number; stage: string }) => void) => {
    ipcRenderer.on('vm-image-download-progress', (_event, progress) => callback(progress))
  },
  // Remote Control pairing
  initiatePairing: (workspaceId: string) => ipcRenderer.invoke('pairing-initiate', workspaceId),
  getPairingStatus: (code: string) => ipcRenderer.invoke('pairing-status', code),
  showRemoteActionNotification: (title: string, body: string) =>
    ipcRenderer.invoke('show-remote-action-notification', title, body),
})
