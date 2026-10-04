// SPDX-License-Identifier: MIT
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
import { execFile } from 'child_process'
import { readConfig, writeConfig, type MeetingConfig } from './config'
import { RecordingManager, type RecordingEvent } from './recording/manager'
import { LiveTranscriber, LIVE_SOURCE_RATE } from './recording/live-transcriber'
import { HttpPcmStreamer, LiveFeed } from './recording/pcm-streamer'
import { getApiUrl } from './local-server'
import {
  MeetingDetector,
  type MeetingDetectedEvent,
  type MeetingEndedEvent,
  type MicUser,
  type UpcomingMeetingEvent,
  type WindowTitle,
} from './detection/meeting-detector'
import {
  startRecordingBridge,
  stopRecordingBridge,
  invokeRendererStart,
  invokeRendererStop,
} from './recording/bridge'
import {
  EMPTY_ISLAND_MEETING_STATE,
  type IslandActionResult,
  type IslandMeetingDecision,
  type IslandMeetingState,
} from './island-protocol'
import { MEETING_PROMPT_TTL_MS, reduceMeetingState, type MeetingEvent } from './island-meeting'
import { pickDesktopMeetingFields, shouldStartMeetingMonitor } from './meeting-config'

const IS_DEV = !app.isPackaged

// ---------------------------------------------------------------------------
// Singletons
// ---------------------------------------------------------------------------

let manager: RecordingManager | null = null
let liveTranscriber: { sessionId: string; live: LiveFeed; heartbeat: ReturnType<typeof setInterval> } | null = null
/** Personal workspace the app reads meetings from; sent with live chunks so they land there. */
let meetingsWorkspaceId: string | null = null
let detector: MeetingDetector | null = null
let durationTimer: ReturnType<typeof setInterval> | null = null
let recordingWindowResolver: (() => BrowserWindow | null) | null = null

// Simple state machine that mirrors the UX we had before — when the mic
// goes quiet for a while (inferred from the absence of an active
// meeting-app process), we auto-stop.
type DetectionState = 'idle' | 'detected' | 'recording' | 'maybe_ended'
let detectionState: DetectionState = 'idle'
let autoStopTimer: ReturnType<typeof setTimeout> | null = null

// What the island shows about meetings: the "record this call?" prompt and
// the recording in progress.
let meetingState: IslandMeetingState = EMPTY_ISLAND_MEETING_STATE
const meetingListeners = new Set<(state: IslandMeetingState) => void>()
let meetingPromptTimer: ReturnType<typeof setTimeout> | null = null
/** Returns true when the island will show the prompt, so the native
 * notification would only duplicate it. */
let meetingPromptPresenter: (() => boolean) | null = null

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
    // `app.getAppPath()` returns `apps/desktop/` in dev. We deliberately don't
    // use `__dirname` here because `bun build` inlines it as a build-time
    // absolute path when this file is bundled into `dist/main.js` (see the
    // post-bundle safety check in `scripts/bundle-main.mjs`).
    const nativeDir = path.join(app.getAppPath(), 'native', 'shogo-sysaudio')
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

function runSysAudioQuery(command: 'mic-users' | 'window-titles'): Promise<unknown[] | null> {
  const binary = getSysAudioBinaryPath()
  if (!binary) return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    execFile(binary, [command], { timeout: 3_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err)
      try {
        const parsed: unknown = JSON.parse(stdout)
        resolve(Array.isArray(parsed) ? parsed : null)
      } catch (parseErr) {
        reject(parseErr)
      }
    })
  })
}

async function listMicUsers(): Promise<MicUser[] | null> {
  return (await runSysAudioQuery('mic-users')) as MicUser[] | null
}

async function listWindowTitles(): Promise<WindowTitle[]> {
  return ((await runSysAudioQuery('window-titles')) as WindowTitle[] | null) ?? []
}

function sendToRenderer(channel: string, data?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, data)
    }
  }
}

function getRecordingWindow(): BrowserWindow | null {
  return recordingWindowResolver?.() ?? null
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
    onPcm: feedLiveTranscript,
  })
  return manager
}

function feedLiveTranscript(
  sessionId: string,
  source: 'mic' | 'system',
  bytes: Uint8Array,
  meta: { sampleRate: number; channels: number },
): void {
  if (!liveTranscriber || liveTranscriber.sessionId !== sessionId) return
  if (meta.sampleRate !== LIVE_SOURCE_RATE) return
  if (source === 'mic' && meta.channels === 1) liveTranscriber.live.feedMic(bytes)
  else if (source === 'system') liveTranscriber.live.feedSystem(bytes, meta.channels)
}

/** Must stay well under the API's stale-draft window (10 minutes). */
const DRAFT_HEARTBEAT_MS = 60_000

/** Headers every live-transcript request carries: the workspace the app reads meetings from. */
function liveHeaders(): Record<string, string> {
  return meetingsWorkspaceId ? { 'x-shogo-workspace-id': meetingsWorkspaceId } : {}
}

function startLiveTranscript(sessionId: string): void {
  liveTranscriber?.live.stop({ discard: true })
  if (liveTranscriber) clearInterval(liveTranscriber.heartbeat)
  const draftUrl = `${getApiUrl()}/api/local/meetings/recordings/${encodeURIComponent(sessionId)}`
  const url = `${draftUrl}/live`
  // Live chunks stop during silence, so check in separately or the API closes the draft.
  const beat = () =>
    void fetch(draftUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...liveHeaders() },
      body: '{}',
    }).catch(() => {})
  beat()
  // Stream the audio when the API can transcribe in real time; otherwise upload short chunks.
  const live = new LiveFeed(
    (onBroken) => new HttpPcmStreamer({ draftUrl, headers: liveHeaders(), onBroken }),
    (startOffsetSeconds) =>
      new LiveTranscriber(async (chunk) => {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'audio/wav',
            'x-live-start': String(chunk.start),
            'x-live-seq': String(chunk.seq),
            ...liveHeaders(),
          },
          body: new Uint8Array(chunk.wav),
        })
        if (!res.ok && res.status !== 409) {
          console.warn(`[Recording] live transcript chunk ${chunk.seq} failed (${res.status})`)
        }
        return { ok: res.ok, status: res.status }
      }, startOffsetSeconds),
  )
  liveTranscriber = { sessionId, heartbeat: setInterval(beat, DRAFT_HEARTBEAT_MS), live }
  void live
    .begin()
    .then((mode) => console.log(`[Recording] live transcript for ${sessionId} via ${mode}`))
    .catch((err) => console.warn('[Recording] live transcript failed to start:', err?.message ?? err))
}

function stopLiveTranscript(): void {
  if (!liveTranscriber) return
  clearInterval(liveTranscriber.heartbeat)
  liveTranscriber.live.stop({ discard: true })
  liveTranscriber = null
}

/** Chunk count to finish the meeting with when the live transcript covers the whole recording. */
async function finishLiveTranscript(sessionId: string, durationSeconds: number): Promise<number | undefined> {
  const current = liveTranscriber
  if (!current || current.sessionId !== sessionId) return undefined
  clearInterval(current.heartbeat)
  liveTranscriber = null
  const summary = await current.live.finish().catch(() => null)
  if (!summary?.complete || summary.seconds < durationSeconds - 3) return undefined
  return summary.chunks
}

function handleRecordingEvent(evt: RecordingEvent): void {
  switch (evt.type) {
    case 'session-started':
      console.log(`[Recording] Session ${evt.session.id} started (primary: ${evt.session.primaryPath})`)
      startLiveTranscript(evt.session.id)
      sendToRenderer('recording-started', { id: evt.session.id, path: evt.session.primaryPath })
      dispatchMeeting({ type: 'recording-started', id: evt.session.id, now: Date.now() })
      break
    case 'session-stopped': {
      console.log(
        `[Recording] Session ${evt.session.id} stopped after ${evt.duration}s ` +
        `(mic=${evt.micBytes} bytes, system=${evt.systemBytes} bytes, mixed=${evt.mixedCreated})`,
      )
      dispatchMeeting({ type: 'recording-stopped' })
      // The renderer finishes the meeting on this event, so hold it until the
      // last live chunk lands (bounded by the transcriber's timeout).
      const { session, duration } = evt
      void finishLiveTranscript(session.id, duration).then((liveChunks) => {
        sendToRenderer('recording-stopped', {
          id: session.id,
          audioPath: session.primaryPath,
          duration,
          ...(liveChunks !== undefined ? { liveChunks } : {}),
        })
      })
      break
    }
    case 'session-aborted':
      stopLiveTranscript()
      console.warn(`[Recording] Session ${evt.id} aborted: ${evt.reason}`)
      dispatchMeeting({ type: 'recording-stopped' })
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
// Meeting state for the island
// ---------------------------------------------------------------------------

function dispatchMeeting(event: MeetingEvent): void {
  const next = reduceMeetingState(meetingState, event)
  if (next === meetingState) return
  meetingState = next
  if (!next.prompt && meetingPromptTimer) {
    clearTimeout(meetingPromptTimer)
    meetingPromptTimer = null
  }
  for (const listener of meetingListeners) listener(next)
}

export function getMeetingState(): IslandMeetingState {
  return meetingState
}

export function onMeetingStateChange(listener: (state: IslandMeetingState) => void): () => void {
  meetingListeners.add(listener)
  return () => {
    meetingListeners.delete(listener)
  }
}

export function setMeetingPromptPresenter(presenter: (() => boolean) | null): void {
  meetingPromptPresenter = presenter
}

/** Starts capture in the app window, which owns the mic pipeline. Starting
 * from main alone would only record system audio. */
async function startMeetingCapture(): Promise<IslandActionResult> {
  if (getManager().isRecording()) {
    dispatchMeeting({ type: 'dismissed' })
    return { ok: true }
  }
  dispatchMeeting({ type: 'busy' })
  const result = await invokeRendererStart(getRecordingWindow())
  if (result.ok) return { ok: true }
  const error = getRecordingWindow()
    ? `Couldn't start recording: ${result.error}`
    : 'Open a Shogo window to record meetings'
  if (detectionState === 'detected') detectionState = 'idle'
  dispatchMeeting({ type: 'failed', error })
  return { ok: false, error }
}

async function stopMeetingCapture(): Promise<IslandActionResult> {
  if (!getManager().isRecording()) {
    dispatchMeeting({ type: 'recording-stopped' })
    return { ok: true }
  }
  dispatchMeeting({ type: 'busy' })
  const result = await invokeRendererStop(getRecordingWindow())
  if (result.ok) return { ok: true }
  try {
    await stopRecording()
    return { ok: true }
  } catch (err) {
    const error = `Couldn't stop recording: ${err instanceof Error ? err.message : String(err)}`
    dispatchMeeting({ type: 'failed', error })
    return { ok: false, error }
  }
}

/** Answers the island's meeting prompt or its recording controls. */
export async function respondToMeeting(
  decision: IslandMeetingDecision,
  promptId?: string,
): Promise<IslandActionResult> {
  if (decision === 'stop') return stopMeetingCapture()
  if (decision === 'dismiss') {
    if (detectionState === 'detected') detectionState = 'idle'
    dispatchMeeting({ type: 'dismissed' })
    return { ok: true }
  }
  if (promptId && meetingState.prompt?.id !== promptId) {
    return { ok: false, error: 'That meeting prompt has expired' }
  }
  const config = readConfig()
  if (!config.meetings.enabled) {
    if (detectionState === 'detected') detectionState = 'idle'
    dispatchMeeting({ type: 'dismissed' })
    return { ok: false, error: 'Meetings are disabled' }
  }
  writeConfig({
    meetings: {
      ...config.meetings,
      autoRecordConfirmCount: config.meetings.autoRecordConfirmCount + 1,
      ...(decision === 'always' ? { autoRecord: true } : {}),
    },
  })
  return startMeetingCapture()
}

// ---------------------------------------------------------------------------
// Public API (imported by main.ts + the HTTP bridge)
// ---------------------------------------------------------------------------

export function setRecordingWindowResolver(resolveWindow: () => BrowserWindow | null): void {
  recordingWindowResolver = resolveWindow
}

export async function startRecording(): Promise<{ id: string; audioPath: string }> {
  // Every start (tray, island, renderer IPC, the API's HTTP bridge) ends up here.
  if (!readConfig().meetings.enabled) throw new Error('Meetings and transcription are disabled')
  const mgr = getManager()
  if (mgr.isRecording()) throw new Error('Already recording')

  if (!getRecordingWindow()) throw new Error('Cannot start recording: no renderer window available')

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
  if (!shouldStartMeetingMonitor(config.meetings)) {
    console.log('[Recording] Auto-detect disabled, skipping monitor')
    return
  }
  if (detector) return

  detector = new MeetingDetector({
    platform: process.platform,
    listMicUsers: process.platform === 'darwin' ? listMicUsers : undefined,
    listWindowTitles: process.platform === 'darwin' ? listWindowTitles : undefined,
  })
  detector.on('meeting-detected', (evt: MeetingDetectedEvent) => {
    console.log(`[Recording] Meeting detected via ${evt.app} (pid ${evt.pid})`)
    sendToRenderer('meeting-detected', { source: evt.source, app: evt.app })
    onMeetingDetected(evt.app)
  })
  detector.on('meeting-ended', (evt: MeetingEndedEvent) => {
    console.log(`[Recording] Meeting ended for ${evt.app}`)
    dispatchMeeting({ type: 'ended', app: evt.app })
    if (detectionState === 'detected' && !meetingState.prompt) detectionState = 'idle'
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
  dispatchMeeting({ type: 'dismissed' })
  if (!detector) return
  detector.stop()
  detector = null
}

function onMeetingDetected(appLabel: string): void {
  if (!readConfig().meetings.enabled) return
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
    void startMeetingCapture().then((result) => {
      if (!result.ok) console.error('[Recording] Auto-record failed:', result.error)
    })
  } else {
    const confirmCount = config.meetings.autoRecordConfirmCount
    const now = Date.now()
    dispatchMeeting({ type: 'detected', app: appLabel, now, suggestAutoRecord: confirmCount >= 2 })
    if (meetingPromptTimer) clearTimeout(meetingPromptTimer)
    meetingPromptTimer = setTimeout(() => {
      meetingPromptTimer = null
      dispatchMeeting({ type: 'expired', now: Date.now() })
      if (detectionState === 'detected' && !meetingState.prompt) detectionState = 'idle'
    }, MEETING_PROMPT_TTL_MS)
    if (meetingPromptPresenter?.()) return

    const promptId = meetingState.prompt?.id
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
      void respondToMeeting(index === 0 ? 'record' : 'dismiss', promptId).then((result) => {
        if (!result.ok) console.error('[Recording] Record from notification failed:', result.error)
      })
    })
    notification.on('close', () => {
      if (detectionState === 'detected') void respondToMeeting('dismiss')
    })
    notification.show()
  }
}

function onMeetingMaybeEnded(): void {
  const mgr = getManager()
  if (!mgr.isRecording() || detectionState !== 'recording') return
  detectionState = 'maybe_ended'
  const config = readConfig()
  // macOS ends a call when the app releases the mic, which happens on hang-up
  // (muting keeps it open), so only a short grace is needed. Elsewhere the
  // signal is "the app's call process went away", which is noisier.
  const waitSeconds =
    process.platform === 'darwin' ? config.meetings.gracePeriodSeconds : config.meetings.autoStopSeconds
  autoStopTimer = setTimeout(() => {
    autoStopTimer = null
    if (detectionState === 'maybe_ended' && mgr.isRecording()) {
      console.log('[Recording] Auto-stopping: meeting ended')
      // Stop through the app window so its mic pipeline shuts down and the
      // meeting is saved, same as pressing Stop.
      void stopMeetingCapture().then((result) => {
        if (result.ok) showNotification('Meeting ended', 'Recording stopped automatically.')
        else console.error('[Recording] Auto-stop failed:', result.error)
      })
    }
  }, waitSeconds * 1000)
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
  ipcMain.handle('meetings:get-workspace', () => meetingsWorkspaceId)
  ipcMain.on('meetings:set-workspace', (_event, workspaceId: unknown) => {
    meetingsWorkspaceId = typeof workspaceId === 'string' && workspaceId ? workspaceId : null
  })

  ipcMain.handle('get-meeting-config', () => readConfig().meetings)
  ipcMain.handle('set-meeting-config', (_event, config: Partial<import('./config').MeetingConfig>) => {
    return setMeetingConfig(config)
  })
}

/**
 * Update the desktop-owned meeting preferences, mirror them to the local API
 * and keep the detector lifecycle in sync. Transcription settings in `patch`
 * are ignored; they are saved through the API.
 */
export async function setMeetingConfig(patch: Partial<MeetingConfig>): Promise<MeetingConfig> {
  const fields = pickDesktopMeetingFields(patch)
  const current = readConfig()
  const next = writeConfig({ meetings: { ...current.meetings, ...fields } }).meetings
  if ('enabled' in fields || 'autoDetect' in fields) {
    if (next.enabled && next.autoDetect) startMeetingMonitor()
    else stopMeetingMonitor()
  }
  await mirrorMeetingConfigToApi(fields)
  return next
}

/** Start the detector and bring the API's mirror up to date after launch. */
export function initMeetingConfig(): void {
  startMeetingMonitor()
  void mirrorMeetingConfigToApi(pickDesktopMeetingFields(readConfig().meetings))
}

async function mirrorMeetingConfigToApi(fields: Partial<MeetingConfig>): Promise<void> {
  if (Object.keys(fields).length === 0) return
  try {
    const res = await fetch(`${getApiUrl()}/api/local/meetings/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fields),
    })
    if (!res.ok) console.warn(`[Recording] Meeting config mirror failed: HTTP ${res.status}`)
  } catch (err) {
    console.warn('[Recording] Meeting config mirror failed:', err instanceof Error ? err.message : err)
  }
}

// ---------------------------------------------------------------------------
// Bridge lifecycle — used by main.ts to let apps/api drive recording.
// ---------------------------------------------------------------------------

export async function startRecordingHttpBridge(): Promise<void> {
  try {
    await startRecordingBridge({
      userDataDir: app.getPath('userData'),
      handlers: {
        start: async () => invokeRendererStart(getRecordingWindow()),
        stop: async () => invokeRendererStop(getRecordingWindow()),
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
