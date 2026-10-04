// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono } from 'hono'
import { prisma, type Meeting } from '../lib/prisma'
import {
  isLocalTranscriptionAvailable,
  getSherpaOfflinePath,
  getInstalledModels,
} from '../services/transcription.service'
import { isDiarizationAvailable } from '../services/diarization.service'
import {
  ensureTranscriptionEngine,
  getTranscriptionInstallStatus,
} from '../services/transcription-install.service'
import {
  startRecording as startRec,
  stopRecording as stopRec,
  getRecordingStatusAsync as getRecStatus,
  BridgeUnavailableError,
} from '../services/recording.service'
import {
  MEETING_LIST_SELECT,
  cleanMeetingNotes,
  defaultMeetingTitle,
  findRecordingDraft,
  isInterruptedDraft,
  parseLiveChunks,
  removeAudioFiles,
  resolveLocalOwnerUserId,
  resolvePersonalWorkspaceId,
  serializeMeeting,
  DICTATION_MAX_BYTES,
  friendlyMeetingError,
  transcribeDictation,
  transcribeMeeting,
  upsertRecordingDraft,
  writeTranscriptToProject,
} from '../services/meeting.service'
import { handleLiveChunk, handleLiveEvents, handleStreamTicket } from './workspace-meetings'
import { describeStreamAvailability, runHttpAudioStream } from '../services/meeting-live-stream'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'

const db = prisma
// LocalConfig exists only in the desktop (SQLite) schema.
const localDb = prisma as any

export const meetingRoutes = new Hono()

interface MeetingOwner {
  workspaceId: string
  userId: string | null
}

/**
 * Recordings belong to the personal workspace. The Electron bridge calls
 * without a session, so fall back to the install's own personal workspace.
 */
async function resolveOwner(c: any): Promise<MeetingOwner | null> {
  const auth = c.get('auth')
  const sessionUserId: string | null = auth?.isAuthenticated && auth.userId ? auth.userId : null
  // The desktop main process has no session. It sends the workspace the app
  // is showing, so live chunks land where the app reads them even when the
  // install has more than one personal workspace.
  // EventSource can't set headers, so the same hint may come as `?workspace=`.
  const hinted = await resolveHintedWorkspaceId(c.req.header(WORKSPACE_HINT_HEADER) || c.req.query('workspace'))
  const workspaceId = hinted ?? (await resolvePersonalWorkspaceId(sessionUserId))
  if (!workspaceId) return null
  return { workspaceId, userId: sessionUserId ?? (await resolveLocalOwnerUserId(workspaceId)) }
}

export const WORKSPACE_HINT_HEADER = 'x-shogo-workspace-id'

/** Local mode only: a personal workspace named by the desktop app, or null when absent or not usable. */
export async function resolveHintedWorkspaceId(hint: string | null | undefined): Promise<string | null> {
  if (process.env.SHOGO_LOCAL_MODE !== 'true' || !hint || hint.length > 128) return null
  const workspace = await db.workspace.findFirst({ where: { id: hint, kind: 'personal' }, select: { id: true } })
  return workspace?.id ?? null
}

/**
 * Create the meeting for a finished recording, or finish the draft the
 * island created while recording (keyed by the recorder's session id).
 */
async function finishRecordedMeeting(
  owner: MeetingOwner,
  input: { audioPath: string; duration?: number | null; recordingId?: string | null; title?: string | null; projectId?: string | null },
  options: { preferLocal?: boolean; liveChunks?: number } = {},
): Promise<{ meeting: Meeting; created: boolean }> {
  const draft = input.recordingId ? await findRecordingDraft(owner.workspaceId, input.recordingId) : null
  const existing =
    draft ??
    (input.audioPath
      ? await db.meeting.findFirst({ where: { audioPath: input.audioPath, workspaceId: owner.workspaceId } })
      : null)

  if (existing && existing.status !== 'recording' && !isInterruptedDraft(existing)) {
    return { meeting: existing, created: false }
  }

  const data = {
    audioPath: input.audioPath,
    duration: input.duration || null,
    status: 'transcribing',
    ...(input.projectId ? { projectId: input.projectId } : {}),
  }
  const meeting = existing
    ? await db.meeting.update({
        where: { id: existing.id },
        data: { ...data, ...(input.title ? { title: input.title } : {}) },
      })
    : await db.meeting.create({
        data: {
          ...data,
          title: input.title || defaultMeetingTitle(new Date()),
          recordingId: input.recordingId || null,
          workspaceId: owner.workspaceId,
          userId: owner.userId,
          source: 'desktop',
        },
      })

  transcribeMeeting(meeting.id, input.audioPath, options).catch((err) => {
    console.error(`[Meetings] Transcription failed for ${meeting.id}:`, err)
  })
  return { meeting, created: !existing }
}

async function loadOwnedMeeting(c: any, id: string) {
  const owner = await resolveOwner(c)
  if (!owner) return null
  const meeting = await db.meeting.findUnique({ where: { id } })
  return meeting && meeting.workspaceId === owner.workspaceId ? meeting : null
}

// Where meetings live, so the app can use the workspace-scoped routes.
meetingRoutes.get('/api/local/meetings/workspace', async (c) => {
  const owner = await resolveOwner(c)
  if (!owner) return c.json({ error: 'No personal workspace found' }, 404)
  return c.json({ workspaceId: owner.workspaceId })
})

// The desktop island's notepad: notes typed while a recording is running.
meetingRoutes.get('/api/local/meetings/recordings/:recordingId', async (c) => {
  const owner = await resolveOwner(c)
  if (!owner) return c.json({ error: 'No personal workspace found' }, 404)
  const meeting = await findRecordingDraft(owner.workspaceId, c.req.param('recordingId'))
  if (!meeting) return c.json({ error: 'Meeting not found' }, 404)
  return c.json({ meeting: serializeMeeting(meeting) })
})

meetingRoutes.put('/api/local/meetings/recordings/:recordingId', async (c) => {
  const owner = await resolveOwner(c)
  if (!owner) return c.json({ error: 'No personal workspace found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const meeting = await upsertRecordingDraft(owner, c.req.param('recordingId'), body)
  return c.json({ meeting: serializeMeeting(meeting) })
})

// Live transcript chunks from the desktop recorder (main process, no session).
meetingRoutes.post('/api/local/meetings/recordings/:recordingId/live', async (c) => {
  const owner = await resolveOwner(c)
  if (!owner) return c.json({ error: 'No personal workspace found' }, 404)
  return handleLiveChunk(c, owner, c.req.param('recordingId'))
})

// Audio-socket ticket for the desktop recorder (main process, no session).
meetingRoutes.post('/api/local/meetings/recordings/:recordingId/stream-ticket', async (c) => {
  const owner = await resolveOwner(c)
  if (!owner) return c.json({ error: 'No personal workspace found' }, 404)
  return handleStreamTicket(c, owner, c.req.param('recordingId'))
})

// Audio for the live transcript as one long chunked POST (the desktop main
// process has no WebSocket client). 16 kHz mono PCM16 in; the coverage summary
// comes back when the body ends.
meetingRoutes.post('/api/local/meetings/recordings/:recordingId/audio-stream', async (c) => {
  // Desktop-only transport; the cloud streams over the ticketed WebSocket.
  if (process.env.SHOGO_LOCAL_MODE !== 'true') return c.json({ error: 'Not found' }, 404)
  const owner = await resolveOwner(c)
  if (!owner) return c.json({ error: 'No personal workspace found' }, 404)
  const availability = await describeStreamAvailability()
  if (!availability.ok) return c.json({ error: availability.reason }, availability.reason === 'disabled' ? 409 : 501)
  const outcome = await runHttpAudioStream(
    c.req.raw.body,
    { workspaceId: owner.workspaceId, userId: owner.userId, recordingId: c.req.param('recordingId'), exp: 0 },
    { signal: c.req.raw.signal },
  )
  return c.json(outcome, outcome.ok ? 200 : outcome.code === 'not_recording' ? 409 : 503)
})

meetingRoutes.get('/api/local/meetings/recordings/:recordingId/live/events', async (c) => {
  const owner = await resolveOwner(c)
  if (!owner) return c.json({ error: 'No personal workspace found' }, 404)
  return handleLiveEvents(c, owner, c.req.param('recordingId'))
})

// One-shot dictation for the chat composer: a short 16 kHz WAV in, text out.
// Electron has no Web Speech backend, so the desktop renderer records and posts here.
meetingRoutes.post('/api/local/transcribe', async (c) => {
  const declared = Number(c.req.header('content-length') || 0)
  if (declared > DICTATION_MAX_BYTES + 64 * 1024) return c.json({ error: 'Audio clip is too large' }, 413)
  let audio: Buffer
  try {
    audio = Buffer.from(await c.req.arrayBuffer())
  } catch {
    return c.json({ error: 'Could not read the audio clip' }, 400)
  }
  try {
    const result = await transcribeDictation(audio)
    if (!result.ok) return c.json({ error: 'Send a WAV clip of 8 MB or less' }, 400)
    return c.json({ text: result.text })
  } catch (err: any) {
    console.warn('[Dictation] Transcription failed:', err?.message ?? err)
    return c.json({ error: friendlyMeetingError('transcript', err) }, 503)
  }
})

// List meetings in the personal workspace
meetingRoutes.get('/api/local/meetings', async (c) => {
  try {
    const owner = await resolveOwner(c)
    if (!owner) return c.json({ meetings: [] })

    const meetings = await db.meeting.findMany({
      where: { workspaceId: owner.workspaceId },
      orderBy: { createdAt: 'desc' },
      select: MEETING_LIST_SELECT,
    })

    return c.json({ meetings })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// =============================================================================
// Meeting config (stored in localConfig key-value store)
// Static routes registered before /:id to avoid param collisions
// =============================================================================

const MEETING_CONFIG_KEYS = [
  'MEETING_ENABLED',
  'MEETING_AUTO_DETECT',
  'MEETING_AUTO_RECORD',
  'MEETING_AUTO_RECORD_CONFIRM_COUNT',
  'MEETING_GRACE_PERIOD_SECONDS',
  'MEETING_AUTO_STOP_SECONDS',
  'MEETING_WHISPER_MODEL',
  'MEETING_USE_CLOUD_TRANSCRIPTION',
  'MEETING_DIARIZATION_ENABLED',
] as const

const MEETING_CONFIG_DEFAULTS: Record<string, string> = {
  MEETING_ENABLED: 'true',
  MEETING_AUTO_DETECT: 'true',
  MEETING_AUTO_RECORD: 'false',
  MEETING_AUTO_RECORD_CONFIRM_COUNT: '0',
  MEETING_GRACE_PERIOD_SECONDS: '10',
  MEETING_AUTO_STOP_SECONDS: '60',
  MEETING_WHISPER_MODEL: 'base.en',
  MEETING_USE_CLOUD_TRANSCRIPTION: 'false',
  MEETING_DIARIZATION_ENABLED: 'true',
}

function configToMeetingResponse(rows: { key: string; value: string }[]) {
  const map: Record<string, string> = {}
  for (const row of rows) map[row.key] = row.value
  return {
    enabled: (map.MEETING_ENABLED ?? MEETING_CONFIG_DEFAULTS.MEETING_ENABLED) === 'true',
    autoDetect: (map.MEETING_AUTO_DETECT ?? MEETING_CONFIG_DEFAULTS.MEETING_AUTO_DETECT) === 'true',
    autoRecord: (map.MEETING_AUTO_RECORD ?? MEETING_CONFIG_DEFAULTS.MEETING_AUTO_RECORD) === 'true',
    autoRecordConfirmCount: parseInt(map.MEETING_AUTO_RECORD_CONFIRM_COUNT ?? MEETING_CONFIG_DEFAULTS.MEETING_AUTO_RECORD_CONFIRM_COUNT, 10),
    gracePeriodSeconds: parseInt(map.MEETING_GRACE_PERIOD_SECONDS ?? MEETING_CONFIG_DEFAULTS.MEETING_GRACE_PERIOD_SECONDS, 10),
    autoStopSeconds: parseInt(map.MEETING_AUTO_STOP_SECONDS ?? MEETING_CONFIG_DEFAULTS.MEETING_AUTO_STOP_SECONDS, 10),
    whisperModel: map.MEETING_WHISPER_MODEL ?? MEETING_CONFIG_DEFAULTS.MEETING_WHISPER_MODEL,
    useCloudTranscription: (map.MEETING_USE_CLOUD_TRANSCRIPTION ?? MEETING_CONFIG_DEFAULTS.MEETING_USE_CLOUD_TRANSCRIPTION) === 'true',
    diarizationEnabled: (map.MEETING_DIARIZATION_ENABLED ?? MEETING_CONFIG_DEFAULTS.MEETING_DIARIZATION_ENABLED) === 'true',
  }
}

async function loadMeetingConfig() {
  const rows = await localDb.localConfig
    .findMany({ where: { key: { in: [...MEETING_CONFIG_KEYS] } } })
    .catch(() => [])
  return configToMeetingResponse(rows)
}

const MEETINGS_DISABLED_ERROR = 'Meetings and transcription are disabled'

meetingRoutes.get('/api/local/meetings/config', async (c) => {
  return c.json(await loadMeetingConfig())
})

meetingRoutes.put('/api/local/meetings/config', async (c) => {
  try {
    const body = await c.req.json<Record<string, any>>()
    const ops: Promise<any>[] = []

    const fieldToKey: Record<string, string> = {
      enabled: 'MEETING_ENABLED',
      autoDetect: 'MEETING_AUTO_DETECT',
      autoRecord: 'MEETING_AUTO_RECORD',
      autoRecordConfirmCount: 'MEETING_AUTO_RECORD_CONFIRM_COUNT',
      gracePeriodSeconds: 'MEETING_GRACE_PERIOD_SECONDS',
      autoStopSeconds: 'MEETING_AUTO_STOP_SECONDS',
      whisperModel: 'MEETING_WHISPER_MODEL',
      useCloudTranscription: 'MEETING_USE_CLOUD_TRANSCRIPTION',
      diarizationEnabled: 'MEETING_DIARIZATION_ENABLED',
    }

    for (const [field, dbKey] of Object.entries(fieldToKey)) {
      if (!(field in body)) continue
      const value = String(body[field])
      ops.push(
        localDb.localConfig.upsert({
          where: { key: dbKey },
          update: { value },
          create: { key: dbKey, value },
        })
      )
    }

    await Promise.all(ops)

    const config = await loadMeetingConfig()
    if (
      config.enabled &&
      (body.enabled === true || 'whisperModel' in body)
    ) {
      void ensureTranscriptionEngine(config.whisperModel).catch((err) => {
        console.warn('[Meetings] Background transcription setup failed:', err?.message ?? err)
      })
    }
    return c.json(config)
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// Transcription + diarization status/capability check
meetingRoutes.get('/api/local/meetings/transcription-status', async (c) => {
  const binaryInstalled = !!getSherpaOfflinePath()
  const installedModels = getInstalledModels()
  const diarizationAvailable = isDiarizationAvailable()
  const model = c.req.query('model') || 'base.en'

  return c.json({
    localAvailable: isLocalTranscriptionAvailable(model),
    cloudAvailable: !!(process.env.OPENAI_API_KEY || process.env.AI_PROXY_URL),
    binaryInstalled,
    installedModels,
    diarizationAvailable,
    install: getTranscriptionInstallStatus(),
  })
})

// Install sherpa-onnx binaries + models
meetingRoutes.post('/api/local/meetings/install-sherpa', async (c) => {
  const { model = 'base.en' } = await c.req.json<{ model?: string }>().catch(() => ({ model: 'base.en' }))
  if (!(await loadMeetingConfig()).enabled) {
    return c.json({ ok: false, error: MEETINGS_DISABLED_ERROR, install: getTranscriptionInstallStatus() }, 409)
  }
  void ensureTranscriptionEngine(model).catch((err) => {
    console.warn('[Meetings] Transcription setup failed:', err?.message ?? err)
  })
  return c.json({ ok: true, install: getTranscriptionInstallStatus() }, 202)
})

// =============================================================================
// Recording (server-side, for dev mode without Electron)
// =============================================================================

// In-memory state for browser-based recordings (no Electron bridge needed).
let browserRecordingState: { isRecording: boolean; id: string | null; startedAt: number } = {
  isRecording: false,
  id: null,
  startedAt: 0,
}

function getRecordingsDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || require('os').homedir()
  const dataDir = process.env.SHOGO_DATA_DIR || join(home, '.shogo')
  const dir = join(dataDir, 'recordings')
  mkdirSync(dir, { recursive: true })
  return dir
}

meetingRoutes.get('/api/local/meetings/recording/status', async (c) => {
  // Try Electron bridge first; fall back to browser recording state
  try {
    const bridgeStatus = await getRecStatus()
    if (bridgeStatus.isRecording) return c.json(bridgeStatus)
  } catch {}

  const duration = browserRecordingState.isRecording
    ? Math.round((Date.now() - browserRecordingState.startedAt) / 1000)
    : 0

  return c.json({
    isRecording: browserRecordingState.isRecording,
    id: browserRecordingState.id,
    duration,
    audioPath: null,
  })
})

meetingRoutes.post('/api/local/meetings/recording/start', async (c) => {
  if (!(await loadMeetingConfig()).enabled) return c.json({ error: MEETINGS_DISABLED_ERROR }, 409)

  // Try Electron bridge first
  try {
    const result = await startRec()
    return c.json(result)
  } catch (err: any) {
    if (!(err instanceof BridgeUnavailableError)) {
      return c.json({ error: err.message }, 400)
    }
  }

  // Fallback: browser-based recording. The actual audio capture happens in the
  // browser via MediaRecorder; the API just tracks state so polling works.
  if (browserRecordingState.isRecording) {
    return c.json({ error: 'Already recording' }, 400)
  }

  const id = `brec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  browserRecordingState = { isRecording: true, id, startedAt: Date.now() }

  return c.json({ id, audioPath: null, mode: 'browser' })
})

meetingRoutes.post('/api/local/meetings/recording/stop', async (c) => {
  // Try Electron bridge first
  try {
    const result = await stopRec()
    if (result) {
      const owner = await resolveOwner(c)
      if (owner) {
        // The app's onStopped IPC listener may also finish this meeting; both dedupe.
        await finishRecordedMeeting(owner, {
          audioPath: result.audioPath,
          duration: result.duration,
          recordingId: (result as { id?: string }).id,
        })
      }
      return c.json({ ...result, mode: 'bridge' })
    }
  } catch (err: any) {
    if (!(err instanceof BridgeUnavailableError)) {
      return c.json({ error: err.message }, 500)
    }
  }

  // Fallback: browser-based recording stop (audio upload handled by /upload)
  if (!browserRecordingState.isRecording) {
    return c.json({ error: 'Not recording' }, 400)
  }

  const duration = Math.round((Date.now() - browserRecordingState.startedAt) / 1000)
  const id = browserRecordingState.id
  browserRecordingState = { isRecording: false, id: null, startedAt: 0 }

  return c.json({ id, duration, mode: 'browser' })
})

// Upload browser-recorded audio and create a meeting
meetingRoutes.post('/api/local/meetings/recording/upload', async (c) => {
  try {
    const contentType = c.req.header('content-type') || ''

    let audioBuffer: Buffer
    let duration = 0
    let recordingId: string | null = null
    let liveChunks: number | undefined

    if (contentType.includes('multipart/form-data')) {
      const formData = await c.req.formData()
      const file = formData.get('audio') as File | null
      if (!file) return c.json({ error: 'No audio file provided' }, 400)
      audioBuffer = Buffer.from(await file.arrayBuffer())
      duration = parseInt(formData.get('duration') as string || '0', 10)
      recordingId = (formData.get('recordingId') as string | null) || null
      liveChunks = parseLiveChunks(formData.get('liveChunks'))
    } else {
      audioBuffer = Buffer.from(await c.req.arrayBuffer())
      duration = parseInt(c.req.header('x-recording-duration') || '0', 10)
      recordingId = c.req.header('x-recording-id') || null
      liveChunks = parseLiveChunks(c.req.header('x-live-chunks'))
    }

    if (audioBuffer.length === 0) {
      return c.json({ error: 'Empty audio data' }, 400)
    }

    const headerHex = audioBuffer.slice(0, 4).toString('hex')
    console.log(`[Meetings] Upload received: ${audioBuffer.length} bytes, header: ${headerHex}`)

    const recDir = getRecordingsDir()
    const id = `brec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const sessionDir = join(recDir, id)
    mkdirSync(sessionDir, { recursive: true })
    const audioPath = join(sessionDir, 'audio.wav')

    const isWav = audioBuffer.length > 4 &&
      audioBuffer[0] === 0x52 && audioBuffer[1] === 0x49 &&
      audioBuffer[2] === 0x46 && audioBuffer[3] === 0x46

    if (isWav) {
      console.log(`[Meetings] File is WAV, saving directly: ${audioBuffer.length} bytes`)
      writeFileSync(audioPath, audioBuffer)
    } else {
      // The browser client should already convert to WAV before uploading, but
      // if for some reason we receive a non-WAV file (e.g. WebM), try ffmpeg.
      const rawPath = join(sessionDir, 'upload.webm')
      writeFileSync(rawPath, audioBuffer)
      try {
        execSync(
          `ffmpeg -y -i "${rawPath}" -ar 16000 -ac 1 -sample_fmt s16 "${audioPath}"`,
          { stdio: 'pipe', timeout: 120_000 },
        )
      } catch (ffErr: any) {
        console.warn('[Meetings] ffmpeg not available, saving as-is. Cloud transcription can handle webm.')
        // Save the raw upload as the audio file — cloud Whisper API supports webm
        const webmPath = join(sessionDir, 'audio.webm')
        writeFileSync(webmPath, audioBuffer)
        // Point audioPath at the webm so transcription can still attempt cloud
        const owner = await resolveOwner(c)
        if (!owner) return c.json({ error: 'No personal workspace found' }, 400)
        const { meeting } = await finishRecordedMeeting(
          owner,
          { audioPath: webmPath, duration, recordingId },
          { preferLocal: false, liveChunks },
        )
        return c.json({ meeting: serializeMeeting(meeting) }, 201)
      }
    }

    const owner = await resolveOwner(c)
    if (!owner) return c.json({ error: 'No personal workspace found' }, 400)
    const { meeting } = await finishRecordedMeeting(owner, { audioPath, duration, recordingId }, { liveChunks })
    return c.json({ meeting: serializeMeeting(meeting) }, 201)
  } catch (err: any) {
    console.error('[Meetings] Upload error:', err)
    return c.json({ error: err.message }, 500)
  }
})

// Get a single meeting with transcript
meetingRoutes.get('/api/local/meetings/:id', async (c) => {
  try {
    const meeting = await loadOwnedMeeting(c, c.req.param('id'))
    if (!meeting) return c.json({ error: 'Meeting not found' }, 404)
    const project = meeting.projectId
      ? await db.project.findUnique({ where: { id: meeting.projectId }, select: { id: true, name: true } })
      : null
    return c.json({ meeting: { ...serializeMeeting(meeting), project } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// Finish a meeting after recording stops (called by the app's onStopped IPC listener)
meetingRoutes.post('/api/local/meetings', async (c) => {
  try {
    const body = await c.req.json<{
      audioPath: string
      duration?: number
      title?: string
      projectId?: string
      recordingId?: string
      liveChunks?: number
    }>()
    if (!body.audioPath) return c.json({ error: 'audioPath is required' }, 400)

    const owner = await resolveOwner(c)
    if (!owner) return c.json({ error: 'No personal workspace found' }, 400)

    const { meeting, created } = await finishRecordedMeeting(owner, body, { liveChunks: parseLiveChunks(body.liveChunks) })
    return c.json({ meeting: serializeMeeting(meeting) }, created ? 201 : 200)
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// Re-trigger transcription
meetingRoutes.post('/api/local/meetings/:id/transcribe', async (c) => {
  try {
    const body = await c.req.json<{ model?: string; useCloud?: boolean }>().catch(() => ({} as { model?: string; useCloud?: boolean }))

    const meeting = await loadOwnedMeeting(c, c.req.param('id'))
    if (!meeting) return c.json({ error: 'Meeting not found' }, 404)
    if (!meeting.audioPath) return c.json({ error: 'This meeting has no recording to transcribe' }, 400)

    await db.meeting.update({
      where: { id: meeting.id },
      // Keep the old transcript until the new one lands, so a failed retry doesn't lose it.
      data: { status: 'transcribing', summary: null },
    })

    transcribeMeeting(meeting.id, meeting.audioPath, {
      model: body.model,
      preferLocal: !body.useCloud,
    }).catch((err) => {
      console.error(`[Meetings] Re-transcription failed for ${meeting.id}:`, err)
    })

    return c.json({ ok: true })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// Attach meeting to a project (writes transcript file to project workspace)
meetingRoutes.post('/api/local/meetings/:id/attach', async (c) => {
  try {
    const { projectId } = await c.req.json<{ projectId: string }>()

    const meeting = await loadOwnedMeeting(c, c.req.param('id'))
    if (!meeting) return c.json({ error: 'Meeting not found' }, 404)

    const updated = await db.meeting.update({
      where: { id: meeting.id },
      data: { projectId },
    })

    if (meeting.transcript) {
      writeTranscriptToProject(projectId, updated)
    }

    return c.json({ meeting: serializeMeeting(updated) })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// Update meeting (title, etc.)
meetingRoutes.put('/api/local/meetings/:id', async (c) => {
  try {
    const body = await c.req.json<{ title?: string; projectId?: string | null; notes?: string | null }>()

    const meeting = await loadOwnedMeeting(c, c.req.param('id'))
    if (!meeting) return c.json({ error: 'Meeting not found' }, 404)

    const notes = cleanMeetingNotes(body.notes)
    const updated = await db.meeting.update({
      where: { id: meeting.id },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
        ...(notes !== undefined ? { notes } : {}),
      },
    })

    return c.json({ meeting: serializeMeeting(updated) })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// Delete a meeting + its audio file
meetingRoutes.delete('/api/local/meetings/:id', async (c) => {
  try {
    const meeting = await loadOwnedMeeting(c, c.req.param('id'))
    if (!meeting) return c.json({ error: 'Meeting not found' }, 404)

    removeAudioFiles(meeting.audioPath)
    await db.meeting.delete({ where: { id: meeting.id } })

    return c.json({ ok: true })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})
