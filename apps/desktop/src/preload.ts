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
  getVMStatus: () => ipcRenderer.invoke('get-vm-status'),
  setVMConfig: (config: { enabled?: boolean | 'auto'; memoryMB?: number; cpus?: number }) =>
    ipcRenderer.invoke('set-vm-config', config),
  onVMImageNeeded: (callback: (data: { downloadUrl: string; imageDir: string }) => void) => {
    ipcRenderer.on('vm-image-needed', (_event, data) => callback(data))
  },
  onVMImageDownloadProgress: (callback: (progress: { bytesDownloaded: number; totalBytes: number; percent: number; stage: string }) => void) => {
    ipcRenderer.on('vm-image-download-progress', (_event, progress) => callback(progress))
  },
  checkVMImageUpdate: () => ipcRenderer.invoke('check-vm-image-update'),
  onVMImageUpdateAvailable: (callback: (data: { currentVersion: string | null; latestVersion: string }) => void) => {
    ipcRenderer.on('vm-image-update-available', (_event, data) => callback(data))
  },
  removeVMImageUpdateListener: () => {
    ipcRenderer.removeAllListeners('vm-image-update-available')
  },

  // Meeting recording
  startRecording: () => ipcRenderer.invoke('start-recording'),
  stopRecording: () => ipcRenderer.invoke('stop-recording'),
  getRecordingStatus: () => ipcRenderer.invoke('get-recording-status'),
  getMeetingConfig: () => ipcRenderer.invoke('get-meeting-config'),
  setMeetingConfig: (config: Record<string, unknown>) => ipcRenderer.invoke('set-meeting-config', config),
  onRecordingStarted: (callback: (data: { id: string; path: string }) => void) => {
    ipcRenderer.on('recording-started', (_event, data) => callback(data))
  },
  onRecordingDuration: (callback: (data: { id: string; duration: number }) => void) => {
    ipcRenderer.on('recording-duration', (_event, data) => callback(data))
  },
  onRecordingStopped: (callback: (data: { id: string; audioPath: string; duration: number }) => void) => {
    ipcRenderer.on('recording-stopped', (_event, data) => callback(data))
  },
  onRecordingResumed: (callback: (data: { id: string }) => void) => {
    ipcRenderer.on('recording-resumed', (_event, data) => callback(data))
  },
  onUpcomingMeeting: (callback: (data: { title: string; start: number; minutesUntilStart: number }) => void) => {
    ipcRenderer.on('upcoming-meeting', (_event, data) => callback(data))
  },
  removeRecordingListeners: () => {
    ipcRenderer.removeAllListeners('recording-started')
    ipcRenderer.removeAllListeners('recording-duration')
    ipcRenderer.removeAllListeners('recording-stopped')
    ipcRenderer.removeAllListeners('recording-resumed')
    ipcRenderer.removeAllListeners('upcoming-meeting')
  },
  onNavigate: (callback: (path: string) => void) => {
    ipcRenderer.on('navigate', (_event, path) => callback(path))
  },
  removeNavigateListener: () => {
    ipcRenderer.removeAllListeners('navigate')
  },

  // App updates
  getUpdateStatus: () => ipcRenderer.invoke('get-update-status'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateStatus: (callback: (data: { status: string; releaseName: string | null }) => void) => {
    ipcRenderer.on('desktop-update-status', (_event, data) => callback(data))
  },
  removeUpdateListener: () => {
    ipcRenderer.removeAllListeners('desktop-update-status')
  },
})
