// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { spawn, type ChildProcess } from 'child_process'
import { app, ipcMain, BrowserWindow, Notification } from 'electron'
import path from 'path'
import fs from 'fs'
import { readConfig, writeConfig } from './config'

const IS_DEV = !app.isPackaged

interface RecordingState {
  id: string
  process: ChildProcess | null
  startTime: Date
  audioPath: string
  duration: number
  durationTimer: ReturnType<typeof setInterval> | null
}

let currentRecording: RecordingState | null = null
let monitorProcess: ChildProcess | null = null

// Meeting detection state machine
type DetectionState = 'idle' | 'mic_active' | 'detected' | 'recording' | 'maybe_ended'
let detectionState: DetectionState = 'idle'
let autoStopTimer: ReturnType<typeof setTimeout> | null = null

function getAudioHelperPath(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  if (IS_DEV) {
    const nativeDir = path.join(__dirname, '..', 'native', 'shogo-audio')
    // Check release build first (from `make build`), then debug (from `swift build`)
    const release = path.join(nativeDir, '.build', 'release', 'shogo-audio')
    if (fs.existsSync(release)) return release
    return path.join(nativeDir, '.build', 'debug', 'shogo-audio')
  }
  return path.join(process.resourcesPath!, 'shogo-audio', `shogo-audio-${arch}`)
}

function getRecordingsDir(): string {
  const dir = path.join(app.getPath('userData'), 'data', 'recordings')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function generateRecordingId(): string {
  const now = new Date()
  const ts = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  return `recording-${ts}`
}

function sendToRenderer(channel: string, data: unknown): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, data)
    }
  }
}

function spawnAudioHelper(): ChildProcess {
  const helperPath = getAudioHelperPath()
  if (!fs.existsSync(helperPath)) {
    throw new Error(`Audio helper not found at ${helperPath}. Run 'make build' in apps/desktop/native/shogo-audio/`)
  }

  const proc = spawn(helperPath, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  proc.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().trim().split('\n')
    for (const line of lines) {
      try {
        const event = JSON.parse(line)
        handleAudioHelperEvent(event)
      } catch {
        console.log(`[AudioHelper] ${line}`)
      }
    }
  })

  proc.stderr?.on('data', (data: Buffer) => {
    console.error(`[AudioHelper] ${data.toString().trim()}`)
  })

  proc.on('error', (err) => {
    console.error('[Recording] Audio helper process error:', err)
  })

  return proc
}

function handleAudioHelperEvent(event: { type: string; data?: Record<string, unknown> }): void {
  switch (event.type) {
    case 'ready':
      console.log('[Recording] Audio helper ready')
      break

    case 'recording_started':
      console.log('[Recording] Recording started:', event.data?.path)
      sendToRenderer('recording-started', {
        id: currentRecording?.id,
        path: event.data?.path,
      })
      break

    case 'recording_stopped':
      console.log('[Recording] Recording stopped:', event.data?.path, 'duration:', event.data?.duration)
      break

    case 'mic_activated':
      console.log('[Recording] Mic activated (external app)')
      if (detectionState === 'idle') {
        detectionState = 'mic_active'
      } else if (detectionState === 'maybe_ended' && currentRecording) {
        // Mic came back during grace period — resume
        if (autoStopTimer) {
          clearTimeout(autoStopTimer)
          autoStopTimer = null
        }
        detectionState = 'recording'
        sendToRenderer('recording-resumed', { id: currentRecording.id })
      }
      break

    case 'mic_deactivated':
      console.log('[Recording] Mic deactivated')
      if (detectionState === 'mic_active') {
        detectionState = 'idle'
      } else if (detectionState === 'recording' && currentRecording) {
        detectionState = 'maybe_ended'
        const config = readConfig()
        autoStopTimer = setTimeout(() => {
          if (detectionState === 'maybe_ended' && currentRecording) {
            console.log('[Recording] Auto-stopping: mic inactive for timeout period')
            showNotification('Meeting ended', 'Recording stopped automatically.')
            stopRecording()
          }
        }, config.meetings.autoStopSeconds * 1000)
      }
      break

    case 'meeting_detected':
      console.log('[Recording] Meeting detected')
      detectionState = 'detected'
      handleMeetingDetected()
      break

    case 'upcoming_meeting':
      console.log('[Recording] Upcoming meeting:', event.data?.title)
      sendToRenderer('upcoming-meeting', event.data)
      break

    case 'calendar_access_granted':
      console.log('[Recording] Calendar access granted')
      break

    case 'calendar_access_denied':
      console.log('[Recording] Calendar access denied:', event.data?.error)
      break

    case 'monitor_started':
      console.log('[Recording] Mic monitor started, device:', event.data?.deviceId)
      break

    case 'error':
      console.error('[Recording] Audio helper error:', event.data?.message)
      break

    case 'shutdown':
      console.log('[Recording] Audio helper shutting down')
      break
  }
}

function handleMeetingDetected(): void {
  if (currentRecording) return // Already recording

  const config = readConfig()

  if (config.meetings.autoRecord) {
    showNotification('Recording started', 'A meeting was detected. Recording automatically.')
    startRecording().catch((err) => {
      console.error('[Recording] Auto-record failed:', err)
    })
  } else {
    const confirmCount = config.meetings.autoRecordConfirmCount
    const notification = new Notification({
      title: 'Meeting detected',
      body: confirmCount >= 2
        ? 'Start recording? (Tip: enable auto-record in settings)'
        : 'It looks like you joined a meeting. Start recording?',
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
      if (detectionState === 'detected') {
        detectionState = 'idle'
      }
    })

    notification.show()
  }
}

function showNotification(title: string, body: string): void {
  new Notification({ title, body }).show()
}

export async function startRecording(): Promise<{ id: string; audioPath: string }> {
  if (currentRecording) {
    throw new Error('Already recording')
  }

  const id = generateRecordingId()
  const audioPath = path.join(getRecordingsDir(), `${id}.wav`)

  const proc = spawnAudioHelper()

  // Wait for "ready" event then send record command
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Audio helper startup timeout')), 10000)

    const onData = (data: Buffer) => {
      const lines = data.toString().trim().split('\n')
      for (const line of lines) {
        try {
          const event = JSON.parse(line)
          if (event.type === 'ready') {
            clearTimeout(timeout)
            proc.stdout?.off('data', onData)
            resolve()
          }
        } catch {}
      }
    }

    proc.stdout?.on('data', onData)
    proc.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })

  proc.stdin?.write(`record ${audioPath}\n`)

  const durationTimer = setInterval(() => {
    if (currentRecording) {
      currentRecording.duration = Math.floor(
        (Date.now() - currentRecording.startTime.getTime()) / 1000
      )
      sendToRenderer('recording-duration', {
        id: currentRecording.id,
        duration: currentRecording.duration,
      })
    }
  }, 1000)

  currentRecording = {
    id,
    process: proc,
    startTime: new Date(),
    audioPath,
    duration: 0,
    durationTimer,
  }

  detectionState = 'recording'
  console.log(`[Recording] Started: ${id} -> ${audioPath}`)

  return { id, audioPath }
}

export async function stopRecording(): Promise<{ id: string; audioPath: string; duration: number } | null> {
  if (!currentRecording) return null

  const { id, audioPath, durationTimer, process: proc } = currentRecording
  const duration = currentRecording.duration

  if (durationTimer) clearInterval(durationTimer)
  if (autoStopTimer) {
    clearTimeout(autoStopTimer)
    autoStopTimer = null
  }

  if (proc && !proc.killed) {
    proc.stdin?.write('stop\n')

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (proc && !proc.killed) proc.kill('SIGTERM')
        resolve()
      }, 5000)

      proc.stdin?.write('quit\n')
      proc.on('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }

  const result = { id, audioPath, duration }
  currentRecording = null
  detectionState = 'idle'

  sendToRenderer('recording-stopped', result)
  console.log(`[Recording] Stopped: ${id}, duration: ${duration}s`)

  return result
}

export function getRecordingStatus(): {
  isRecording: boolean
  id: string | null
  duration: number
  audioPath: string | null
} {
  if (!currentRecording) {
    return { isRecording: false, id: null, duration: 0, audioPath: null }
  }
  return {
    isRecording: true,
    id: currentRecording.id,
    duration: currentRecording.duration,
    audioPath: currentRecording.audioPath,
  }
}

export function startMeetingMonitor(): void {
  const config = readConfig()
  if (!config.meetings.autoDetect) {
    console.log('[Recording] Auto-detect disabled, skipping monitor')
    return
  }

  if (monitorProcess) {
    console.log('[Recording] Monitor already running')
    return
  }

  try {
    monitorProcess = spawnAudioHelper()

    // Wait for ready, then start monitor
    const onData = (data: Buffer) => {
      const lines = data.toString().trim().split('\n')
      for (const line of lines) {
        try {
          const event = JSON.parse(line)
          if (event.type === 'ready') {
            monitorProcess?.stdout?.off('data', onData)
            monitorProcess?.stdin?.write(`monitor ${config.meetings.gracePeriodSeconds}\n`)
            console.log('[Recording] Meeting monitor started')
          }
        } catch {}
      }
    }

    monitorProcess.stdout?.on('data', onData)

    monitorProcess.on('exit', (code) => {
      console.log(`[Recording] Monitor process exited: ${code}`)
      monitorProcess = null
    })
  } catch (err) {
    console.error('[Recording] Failed to start meeting monitor:', err)
  }
}

export function stopMeetingMonitor(): void {
  if (monitorProcess && !monitorProcess.killed) {
    monitorProcess.stdin?.write('stop-monitor\n')
    monitorProcess.stdin?.write('quit\n')
    monitorProcess = null
  }
}

export function registerRecordingIpcHandlers(): void {
  ipcMain.handle('start-recording', async () => {
    try {
      return await startRecording()
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('stop-recording', async () => {
    try {
      return await stopRecording()
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('get-recording-status', () => {
    return getRecordingStatus()
  })

  ipcMain.handle('get-meeting-config', () => {
    return readConfig().meetings
  })

  ipcMain.handle('set-meeting-config', (_event, config: Partial<import('./config').MeetingConfig>) => {
    const current = readConfig()
    writeConfig({ meetings: { ...current.meetings, ...config } })

    // Restart monitor if auto-detect changed
    if ('autoDetect' in config) {
      if (config.autoDetect) {
        startMeetingMonitor()
      } else {
        stopMeetingMonitor()
      }
    }

    return readConfig().meetings
  })
}

export function cleanupRecording(): void {
  if (currentRecording) {
    stopRecording().catch(() => {})
  }
  stopMeetingMonitor()
}
