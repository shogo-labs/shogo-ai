// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Thin facade over the cross-platform recording pipeline.
 *
 * - Audio capture lives in the renderer (`AudioCaptureManager` using
 *   `getUserMedia` + `getDisplayMedia` + `AudioWorklet`).
 * - Main-process file I/O lives in {@link RecordingManager}; on macOS it
 *   also spawns `shogo-sysaudio` for system audio.
 * - Meeting detection (process + calendar polling) lives in
 *   {@link MeetingDetector} — pure Node, no native dependency.
 *
 * This module is the glue: it owns the singletons, registers IPC handlers
 * the preload script talks to, forwards detector events to the renderer,
 * and starts the localhost HTTP bridge the Bun API uses in headless mode.
 */
import { app, ipcMain, BrowserWindow, Notification } from 'electron'
import type { IpcMainEvent, MessageEvent as ElectronMessageEvent } from 'electron'
import path from 'path'
import fs from 'fs'
import { readConfig, writeConfig } from './config'
import { RecordingManager, type RecordingEvent } from './recording/manager'
import {
  MeetingDetector,
  type MeetingDetectedEvent,
  type MeetingEndedEvent,
  type UpcomingMeetingEvent,
} from './detection/meeting-detector'
import {
  startRecordingBridge,
  stopRecordingBridge,
  invokeRendererStart,
  invokeRendererStop,
} from './recording/bridge'

const IS_DEV = !app.isPackaged

// ---------------------------------------------------------------------------
// Singletons
// ---------------------------------------------------------------------------

let manager: RecordingManager | null = null
let detector: MeetingDetector | null = null
let durationTimer: ReturnType<typeof setInterval> | null = null

// Simple state machine that mirrors the UX we had before — when the mic
// goes quiet for a while (inferred from the absence of an active
// meeting-app process), we auto-stop.
type DetectionState = 'idle' | 'detected' | 'recording' | 'maybe_ended'
let detectionState: DetectionState = 'idle'
let autoStopTimer: ReturnType<typeof setTimeout> | null = null

// ---------------------------------------------------------------------------
// Paths / helpers
// ---------------------------------------------------------------------------

function getRecordingsDir(): string {
  const dir = path.join(app.getPath('userData'), 'data', 'recordings')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function getSysAudioBinaryPath(): string | null {
  if (process.platform !== 'darwin') return null
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  if (IS_DEV) {
    const nativeDir = path.join(__dirname, '..', 'native', 'shogo-sysaudio')
    const candidates = [
      path.join(nativeDir, `shogo-sysaudio-${arch}`),
      path.join(nativeDir, '.build', 'release', 'shogo-sysaudio'),
      path.join(nativeDir, '.build', 'debug', 'shogo-sysaudio'),
    ]
    for (const p of candidates) if (fs.existsSync(p)) return p
    return null
  }
  const packed = path.join(process.resourcesPath!, 'shogo-sysaudio', `shogo-sysaudio-${arch}`)
  return fs.existsSync(packed) ? packed : null
}

function sendToRenderer(channel: string, data?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, data)
    }
  }
}

function getManager(): RecordingManager {
  if (manager) return manager
  const sysBinary = getSysAudioBinaryPath()
  if (process.platform === 'darwin' && !sysBinary) {
    console.warn('[Recording] shogo-sysaudio binary not found — system audio will not be captured')
  }
  manager = new RecordingManager({
    recordingsDir: getRecordingsDir(),
    sysAudioBinary: sysBinary,
    onEvent: handleRecordingEvent,
  })
  return manager
}

function handleRecordingEvent(evt: RecordingEvent): void {
  switch (evt.type) {
    case 'session-started':
      console.log(`[Recording] Session ${evt.session.id} started (primary: ${evt.session.primaryPath})`)
      sendToRenderer('recording-started', { id: evt.session.id, path: evt.session.primaryPath })
      break
    case 'session-stopped':
      console.log(
        `[Recording] Session ${evt.session.id} stopped after ${evt.duration}s ` +
        `(mic=${evt.micBytes} bytes, system=${evt.systemBytes} bytes, mixed=${evt.mixedCreated})`,
      )
      sendToRenderer('recording-stopped', {
        id: evt.session.id,
        audioPath: evt.session.primaryPath,
        duration: evt.duration,
      })
      break
    case 'session-aborted':
      console.warn(`[Recording] Session ${evt.id} aborted: ${evt.reason}`)
      break
    case 'source-ready':
      console.log(`[Recording] ${evt.source} source ready: ${evt.sampleRate}Hz x${evt.channels}`)
      break
    case 'source-error':
      console.error(`[Recording] ${evt.source} source error: ${evt.message}`)
      break
    case 'warning':
      console.warn(`[Recording] ${evt.message}`)
      break
  }
}

// ---------------------------------------------------------------------------
// Public API (imported by main.ts + the HTTP bridge)
// ---------------------------------------------------------------------------

export async function startRecording(): Promise<{ id: string; audioPath: string }> {
  const mgr = getManager()
  if (mgr.isRecording()) throw new Error('Already recording')

  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (!win) throw new Error('Cannot start recording: no renderer window available')

  const session = await mgr.startSession(process.platform)

  if (durationTimer) clearInterval(durationTimer)
  durationTimer = setInterval(() => {
    const status = mgr.status()
    if (status.isRecording && status.id) {
      sendToRenderer('recording-duration', { id: status.id, duration: status.duration })
    }
  }, 1000)

  detectionState = 'recording'

  return { id: session.id, audioPath: session.primaryPath }
}

export async function stopRecording(): Promise<{ id: string; audioPath: string; duration: number } | null> {
  const mgr = getManager()
  if (!mgr.isRecording()) return null

  if (durationTimer) {
    clearInterval(durationTimer)
    durationTimer = null
  }
  if (autoStopTimer) {
    clearTimeout(autoStopTimer)
    autoStopTimer = null
  }

  const result = await mgr.stopSession()
  detectionState = 'idle'
  return result
}

export function getRecordingStatus(): {
  isRecording: boolean
  id: string | null
  duration: number
  audioPath: string | null
} {
  const s = getManager().status()
  return { isRecording: s.isRecording, id: s.id, duration: s.duration, audioPath: s.audioPath }
}

// ---------------------------------------------------------------------------
// Detection (replaces the old Swift monitor process)
// ---------------------------------------------------------------------------

export function startMeetingMonitor(): void {
  const config = readConfig()
  if (!config.meetings.autoDetect) {
    console.log('[Recording] Auto-detect disabled, skipping monitor')
    return
  }
  if (detector) return

  detector = new MeetingDetector({ platform: process.platform })
  detector.on('meeting-detected', (evt: MeetingDetectedEvent) => {
    console.log(`[Recording] Meeting detected via ${evt.app} (pid ${evt.pid})`)
    sendToRenderer('meeting-detected', { source: evt.source, app: evt.app })
    onMeetingDetected(evt.app)
  })
  detector.on('meeting-ended', (evt: MeetingEndedEvent) => {
    console.log(`[Recording] Meeting ended for ${evt.app}`)
    onMeetingMaybeEnded()
  })
  detector.on('upcoming-meeting', (evt: UpcomingMeetingEvent) => {
    console.log(`[Recording] Upcoming meeting: ${evt.title} in ${evt.minutesUntilStart}m`)
    sendToRenderer('upcoming-meeting', evt)
  })
  detector.on('warning', ({ message }: { message: string }) => {
    console.warn(`[Recording] Detector warning: ${message}`)
  })

  detector.start()
  console.log('[Recording] Meeting detector started (pure Node)')
}

export function stopMeetingMonitor(): void {
  if (!detector) return
  detector.stop()
  detector = null
}

function onMeetingDetected(appLabel: string): void {
  const mgr = getManager()
  if (mgr.isRecording()) {
    // Already recording — if we were in the grace window, cancel the auto-stop.
    if (detectionState === 'maybe_ended' && autoStopTimer) {
      clearTimeout(autoStopTimer)
      autoStopTimer = null
      detectionState = 'recording'
      sendToRenderer('recording-resumed', { id: mgr.status().id })
    }
    return
  }

  detectionState = 'detected'
  const config = readConfig()
  if (config.meetings.autoRecord) {
    showNotification('Recording started', `${appLabel} meeting detected — recording automatically.`)
    startRecording().catch((err) => {
      console.error('[Recording] Auto-record failed:', err)
    })
  } else {
    const confirmCount = config.meetings.autoRecordConfirmCount
    const notification = new Notification({
      title: 'Meeting detected',
      body:
        confirmCount >= 2
          ? `${appLabel} started — start recording? (Tip: enable auto-record in settings)`
          : `${appLabel} meeting detected. Start recording?`,
      actions: [
        { type: 'button', text: 'Record' },
        { type: 'button', text: 'Ignore' },
      ],
    })
    notification.on('action', (_event, index) => {
      if (index === 0) {
        writeConfig({
          meetings: {
            ...config.meetings,
            autoRecordConfirmCount: confirmCount + 1,
          },
        })
        startRecording().catch((err) => {
          console.error('[Recording] Record from notification failed:', err)
        })
      } else {
        detectionState = 'idle'
      }
    })
    notification.on('close', () => {
      if (detectionState === 'detected') detectionState = 'idle'
    })
    notification.show()
  }
}

function onMeetingMaybeEnded(): void {
  const mgr = getManager()
  if (!mgr.isRecording() || detectionState !== 'recording') return
  detectionState = 'maybe_ended'
  const config = readConfig()
  autoStopTimer = setTimeout(() => {
    if (detectionState === 'maybe_ended' && mgr.isRecording()) {
      console.log('[Recording] Auto-stopping: meeting app no longer running')
      showNotification('Meeting ended', 'Recording stopped automatically.')
      stopRecording().catch(() => {})
    }
  }, config.meetings.autoStopSeconds * 1000)
}

function showNotification(title: string, body: string): void {
  try { new Notification({ title, body }).show() } catch { /* fall through — headless */ }
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

export function registerRecordingIpcHandlers(): void {
  // Renderer-driven capture lifecycle. The preload script calls these after
  // it has set up the Web Audio pipeline so main and renderer agree on the
  // session id used to tag PCM chunks.
  ipcMain.handle('recording:start-session', async () => {
    try {
      const mgr = getManager()
      if (mgr.isRecording()) return { ok: false, error: 'already recording' }
      const session = await mgr.startSession(process.platform)

      if (durationTimer) clearInterval(durationTimer)
      durationTimer = setInterval(() => {
        const s = mgr.status()
        if (s.isRecording && s.id) {
          sendToRenderer('recording-duration', { id: s.id, duration: s.duration })
        }
      }, 1000)
      detectionState = 'recording'

      return {
        ok: true,
        id: session.id,
        audioPath: session.primaryPath,
        captureSystemAudio: session.captureSystemAudio,
        platform: session.platform,
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('recording:abort-session', (_event, arg: { sessionId?: string } = {}) => {
    const mgr = getManager()
    const status = mgr.status()
    if (!status.isRecording) return { ok: true }
    if (arg.sessionId && status.id !== arg.sessionId) return { ok: false, error: 'session id mismatch' }
    mgr.abortSession(status.id!, 'aborted by renderer')
    if (durationTimer) { clearInterval(durationTimer); durationTimer = null }
    detectionState = 'idle'
    return { ok: true }
  })

  ipcMain.handle('recording:stop-session', async () => {
    try {
      const result = await stopRecording()
      if (!result) return { ok: false, error: 'not recording' }
      return { ok: true, ...result }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // PCM chunks arrive via `ipcRenderer.postMessage` (transferable ArrayBuffer)
  // rather than `send/invoke` so we can move large buffers with zero copies.
  ipcMain.on('recording:pcm', (event: IpcMainEvent | ElectronMessageEvent, rawData: unknown) => {
    const data = rawData as {
      sessionId: string
      source: 'mic' | 'system'
      sampleRate: number
      channels: number
      bitsPerSample: number
      frames: number
      buffer: ArrayBuffer
    } | undefined
    if (!data || !(data.buffer instanceof ArrayBuffer)) return
    const mgr = getManager()
    mgr.writePcm(data.sessionId, data.source, data.buffer, {
      sampleRate: data.sampleRate,
      channels: data.channels,
      bitsPerSample: data.bitsPerSample,
      frames: data.frames,
    })
    void event // the base IpcMainEvent/MessageEvent type union resolves here — we don't need it
  })

  ipcMain.on('recording:source-error', (_event, payload: { sessionId?: string; source?: string; message?: string }) => {
    console.error(`[Recording] renderer reported ${payload.source} error:`, payload.message)
  })
  ipcMain.on('recording:source-info', (_event, payload: { message?: string; data?: unknown }) => {
    if (payload.message) console.log(`[Recording] renderer info: ${payload.message}`, payload.data ?? '')
  })
  ipcMain.on('recording:capture-ready', (_event, payload: { sessionId?: string; mic?: unknown; system?: unknown }) => {
    console.log('[Recording] renderer capture pipeline ready', payload)
  })

  // Legacy public surface preserved for the React app.
  ipcMain.handle('start-recording', async () => {
    try { return await startRecording() } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('stop-recording', async () => {
    try { return await stopRecording() } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('get-recording-status', () => getRecordingStatus())

  ipcMain.handle('get-meeting-config', () => readConfig().meetings)
  ipcMain.handle('set-meeting-config', (_event, config: Partial<import('./config').MeetingConfig>) => {
    const current = readConfig()
    writeConfig({ meetings: { ...current.meetings, ...config } })
    if ('autoDetect' in config) {
      if (config.autoDetect) startMeetingMonitor()
      else stopMeetingMonitor()
    }
    return readConfig().meetings
  })
}

// ---------------------------------------------------------------------------
// Bridge lifecycle — used by main.ts to let apps/api drive recording.
// ---------------------------------------------------------------------------

export async function startRecordingHttpBridge(): Promise<void> {
  try {
    await startRecordingBridge({
      userDataDir: app.getPath('userData'),
      handlers: {
        start: async () => invokeRendererStart(),
        stop: async () => invokeRendererStop(),
        status: () => getRecordingStatus(),
      },
    })
  } catch (err) {
    console.warn('[Recording] HTTP bridge failed to start:', err)
  }
}

export function cleanupRecording(): void {
  if (manager?.isRecording()) {
    stopRecording().catch(() => {})
  }
  stopMeetingMonitor()
  void stopRecordingBridge()
}
