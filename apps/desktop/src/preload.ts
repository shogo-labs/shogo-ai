// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { contextBridge, ipcRenderer } from 'electron'
import { AudioCaptureManager, type PcmChunkMessage } from './audio/audio-capture-manager'

const portArg = process.argv.find((a) => a.startsWith('--api-port='))
const apiPort = portArg ? portArg.split('=')[1] : '39100'

// --- Recording capture pipeline (runs here, in the renderer) ----------------

interface ActiveSession {
  id: string
  audioPath: string
  manager: AudioCaptureManager
}

let activeSession: ActiveSession | null = null

function sendPcmChunk(sessionId: string, source: 'mic' | 'system', chunk: PcmChunkMessage): void {
  // Electron's `ipcRenderer.postMessage` only accepts MessagePort objects in
  // the transfer list — unlike the web MessagePort API, ArrayBuffers are NOT
  // transferable across its IPC boundary (the structured-clone copy is done
  // by the IPC layer regardless). That's fine: 100 ms of 48 kHz mono Int16
  // is ~9.6 KB per message, well below any meaningful overhead.
  ipcRenderer.postMessage('recording:pcm', {
    sessionId,
    source,
    sampleRate: chunk.sampleRate,
    channels: chunk.channels,
    bitsPerSample: chunk.bitsPerSample,
    frames: chunk.frames,
    buffer: chunk.buffer,
  })
}

async function stopActive(): Promise<void> {
  if (!activeSession) return
  try {
    await activeSession.manager.stop()
  } catch (err) {
    console.warn('[ShogoPreload] capture stop error:', err)
  }
  activeSession = null
}

async function startRecording(): Promise<{ ok: boolean; id?: string; audioPath?: string; error?: string }> {
  if (activeSession) {
    return { ok: false, error: 'already recording' }
  }

  const session = (await ipcRenderer.invoke('recording:start-session')) as
    | { ok: true; id: string; audioPath: string; captureSystemAudio: boolean; platform: NodeJS.Platform }
    | { ok: false; error: string }

  if (!session.ok) {
    return { ok: false, error: session.error }
  }

  const manager = new AudioCaptureManager({
    onPcm: (source, chunk) => sendPcmChunk(session.id, source, chunk),
    onError: (source, err) => {
      ipcRenderer.send('recording:source-error', {
        sessionId: session.id,
        source,
        message: err.message,
      })
    },
    onInfo: (message, data) => {
      ipcRenderer.send('recording:source-info', { sessionId: session.id, message, data })
    },
  })

  try {
    const result = await manager.start({
      sessionId: session.id,
      captureSystemAudio: session.captureSystemAudio,
      platform: session.platform,
    })
    ipcRenderer.send('recording:capture-ready', {
      sessionId: session.id,
      mic: result.mic,
      system: result.system,
    })
    if (!result.mic) {
      await manager.stop()
      await ipcRenderer.invoke('recording:abort-session', { sessionId: session.id })
      return { ok: false, error: 'microphone capture failed (permission denied?)' }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await ipcRenderer.invoke('recording:abort-session', { sessionId: session.id })
    return { ok: false, error: message }
  }

  activeSession = { id: session.id, audioPath: session.audioPath, manager }
  return { ok: true, id: session.id, audioPath: session.audioPath }
}

async function stopRecording(): Promise<{ ok: boolean; id?: string; audioPath?: string; duration?: number; error?: string }> {
  const session = activeSession
  await stopActive()
  const stopped = (await ipcRenderer.invoke('recording:stop-session')) as
    | { ok: true; id: string; audioPath: string; duration: number }
    | { ok: false; error: string }
  if (!stopped.ok) return { ok: false, error: stopped.error }
  return {
    ok: true,
    id: session?.id ?? stopped.id,
    audioPath: stopped.audioPath,
    duration: stopped.duration,
  }
}

// Abort any in-flight capture if the window is torn down abruptly.
window.addEventListener('beforeunload', () => { void stopActive() })

// --- Exposed surface -------------------------------------------------------

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
  setVMConfig: (config: { enabled?: boolean | 'auto'; memoryMB?: number; cpus?: number; mountWorkspace?: boolean }) =>
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
  recycleVMPool: () => ipcRenderer.invoke('recycle-vm-pool'),

  // Meeting recording — renderer owns the Web Audio pipeline, main owns the
  // file I/O + (on macOS) the shogo-sysaudio child process.
  startRecording: () => startRecording(),
  stopRecording: () => stopRecording(),
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
  onMeetingDetected: (callback: (data: { source: string; app?: string; title?: string }) => void) => {
    ipcRenderer.on('meeting-detected', (_event, data) => callback(data))
  },
  removeRecordingListeners: () => {
    ipcRenderer.removeAllListeners('recording-started')
    ipcRenderer.removeAllListeners('recording-duration')
    ipcRenderer.removeAllListeners('recording-stopped')
    ipcRenderer.removeAllListeners('recording-resumed')
    ipcRenderer.removeAllListeners('upcoming-meeting')
    ipcRenderer.removeAllListeners('meeting-detected')
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
  showRemoteActionNotification: (title: string, body: string) =>
    ipcRenderer.invoke('show-remote-action-notification', title, body),
  showChatNotification: (args: {
    title: string
    body: string
    sessionId: string
    projectId: string
  }) => ipcRenderer.invoke('show-chat-notification', args),
  onNotificationClicked: (
    callback: (data: { sessionId: string; projectId: string }) => void,
  ) => {
    ipcRenderer.on('notification-clicked', (_event, data) => callback(data))
  },
  removeNotificationClickedListener: () => {
    ipcRenderer.removeAllListeners('notification-clicked')
  },
  isWindowFocused: () => ipcRenderer.invoke('get-window-focused'),

  // Cloud login (replaces the old paste-API-key flow)
  getDeviceInfo: (): Promise<{ id: string; name: string; platform: string; appVersion: string }> =>
    ipcRenderer.invoke('get-device-info'),
  startCloudLogin: (opts?: { workspaceId?: string }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('start-cloud-login', opts),
  signOutCloud: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('sign-out-cloud'),
  onCloudLoginResult: (
    callback: (result: { ok: boolean; error?: string; email?: string; workspace?: string }) => void,
  ) => {
    ipcRenderer.on('cloud-login-result', (_event, result) => callback(result))
  },
  removeCloudLoginListener: () => {
    ipcRenderer.removeAllListeners('cloud-login-result')
  },
})
