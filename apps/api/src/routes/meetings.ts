// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import {
  isLocalTranscriptionAvailable,
  getSherpaOfflinePath,
  getInstalledModels,
} from '../services/transcription.service'
import { isDiarizationAvailable } from '../services/diarization.service'
import {
  startRecording as startRec,
  stopRecording as stopRec,
  getRecordingStatusAsync as getRecStatus,
  BridgeUnavailableError,
} from '../services/recording.service'
import {
  MEETING_LIST_SELECT,
  defaultMeetingTitle,
  findRecordingDraft,
  isInterruptedDraft,
  parseLiveChunks,
  removeAudioFiles,
  resolveLocalOwnerUserId,
  resolvePersonalWorkspaceId,
  serializeMeeting,
  transcribeMeeting,
  upsertRecordingDraft,
  writeTranscriptToProject,
} from '../services/meeting.service'
import { handleLiveChunk } from './workspace-meetings'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))

// Locates apps/desktop/scripts/download-sherpa.mjs in both dev and packaged builds.
// Dev: apps/api/src/routes/meetings.ts -> ../../../desktop/scripts/download-sherpa.mjs
// Packaged: bundle-api.mjs copies the script to resources/scripts/download-sherpa.mjs,
// and local-server sets cwd to resourcesPath, so cwd/scripts/download-sherpa.mjs resolves it.
function findDownloadSherpaScript(): string | null {
  const candidates = [
    resolve(MODULE_DIR, '..', '..', '..', 'desktop', 'scripts', 'download-sherpa.mjs'),
    resolve(process.cwd(), 'scripts', 'download-sherpa.mjs'),
    resolve(process.cwd(), 'apps', 'desktop', 'scripts', 'download-sherpa.mjs'),
    resolve(process.cwd(), '..', '..', 'apps', 'desktop', 'scripts', 'download-sherpa.mjs'),
    resolve((process as any).resourcesPath || '', 'scripts', 'download-sherpa.mjs'),
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return null
}

// Prefer the bun binary the desktop shell spawned us with (packaged users likely
// don't have `node` on PATH). Falls back to `bun` then `node`.
function getScriptInterpreter(): string {
  return process.env.SHOGO_BUN_PATH || 'bun'
}

const db = prisma as any

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
  const workspaceId = await resolvePersonalWorkspaceId(sessionUserId)
  if (!workspaceId) return null
  return { workspaceId, userId: sessionUserId ?? (await resolveLocalOwnerUserId(workspaceId)) }
}

/**
 * Create the meeting for a finished recording, or finish the draft the
 * island created while recording (keyed by the recorder's session id).
 */
async function finishRecordedMeeting(
  owner: MeetingOwner,
  input: { audioPath: string; duration?: number | null; recordingId?: string | null; title?: string | null; projectId?: string | null },
  options: { preferLocal?: boolean; liveChunks?: number } = {},
): Promise<{ meeting: any; created: boolean }> {
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

meetingRoutes.get('/api/local/meetings/config', async (c) => {
  try {
    const rows = await db.localConfig.findMany({
      where: { key: { in: [...MEETING_CONFIG_KEYS] } },
    })
    return c.json(configToMeetingResponse(rows))
  } catch {
    return c.json(configToMeetingResponse([]))
  }
})

meetingRoutes.put('/api/local/meetings/config', async (c) => {
  try {
    const body = await c.req.json<Record<string, any>>()
    const ops: Promise<any>[] = []

    const fieldToKey: Record<string, string> = {
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
        db.localConfig.upsert({
          where: { key: dbKey },
          update: { value },
          create: { key: dbKey, value },
        })
      )
    }

    await Promise.all(ops)

    const rows = await db.localConfig.findMany({
      where: { key: { in: [...MEETING_CONFIG_KEYS] } },
    })
    return c.json(configToMeetingResponse(rows))
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// Transcription + diarization status/capability check
meetingRoutes.get('/api/local/meetings/transcription-status', async (c) => {
  const binaryInstalled = !!getSherpaOfflinePath()
  const installedModels = getInstalledModels()
  const diarizationAvailable = isDiarizationAvailable()

  return c.json({
    localAvailable: isLocalTranscriptionAvailable(),
    cloudAvailable: !!(process.env.OPENAI_API_KEY || process.env.AI_PROXY_URL),
    binaryInstalled,
    installedModels,
    diarizationAvailable,
  })
})

// Install sherpa-onnx binaries + models
meetingRoutes.post('/api/local/meetings/install-sherpa', async (c) => {
  const { model = 'base.en' } = await c.req.json<{ model?: string }>().catch(() => ({ model: 'base.en' }))

  const steps: string[] = []

  try {
    const scriptPath = findDownloadSherpaScript()
    if (!scriptPath) {
      return c.json(
        {
          error:
            'download-sherpa.mjs not found. Expected at apps/desktop/scripts/download-sherpa.mjs relative to the API source or repo root.',
        },
        500,
      )
    }

    const interpreter = getScriptInterpreter()
    // In packaged mode SHOGO_SHERPA_DIR points into the user data dir (writable);
    // in dev it's unset and the script falls back to apps/desktop/resources/sherpa-onnx.
    const destDir = process.env.SHOGO_SHERPA_DIR || ''

    steps.push(`Installing sherpa-onnx with model ${model}...`)
    steps.push(`Running: ${interpreter} ${scriptPath} --model ${model}`)
    if (destDir) steps.push(`Destination: ${destDir}`)

    execSync(`"${interpreter}" "${scriptPath}" --model ${model}`, {
      timeout: 600_000,
      encoding: 'utf-8',
      stdio: 'pipe',
      env: {
        ...process.env,
        ...(destDir ? { SHERPA_DEST_DIR: destDir } : {}),
      },
    })
    steps.push('sherpa-onnx installed successfully')

    return c.json({ ok: true, steps })
  } catch (err: any) {
    steps.push(`Error: ${err.message}`)
    return c.json({ error: err.message, steps }, 500)
  }
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

    const updated = await db.meeting.update({
      where: { id: meeting.id },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
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
