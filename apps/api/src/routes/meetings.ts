// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import {
  transcribe,
  isLocalTranscriptionAvailable,
  getSherpaOfflinePath,
  getInstalledModels,
} from '../services/transcription.service'
import {
  isDiarizationAvailable,
  diarize,
  mergeTranscriptWithSpeakers,
  splitTextBySpeakers,
} from '../services/diarization.service'
import {
  startRecording as startRec,
  stopRecording as stopRec,
  getRecordingStatusAsync as getRecStatus,
  BridgeUnavailableError,
} from '../services/recording.service'
import { existsSync, unlinkSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'fs'
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

// List meetings for the workspace
meetingRoutes.get('/api/local/meetings', async (c) => {
  try {
    const workspace = await db.workspace.findFirst()
    if (!workspace) return c.json({ meetings: [] })

    const meetings = await db.meeting.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        duration: true,
        status: true,
        projectId: true,
        createdAt: true,
        updatedAt: true,
      },
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
      const workspace = await db.workspace.findFirst()
      if (workspace) {
        const title = formatMeetingTitle(new Date())
        const meeting = await db.meeting.create({
          data: {
            title,
            audioPath: result.audioPath,
            duration: result.duration,
            status: 'transcribing',
            workspaceId: workspace.id,
          },
        })

        transcribeMeeting(meeting.id, result.audioPath).catch((err) => {
          console.error(`[Meetings] Transcription failed for ${meeting.id}:`, err)
        })
      }
      return c.json(result)
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

    if (contentType.includes('multipart/form-data')) {
      const formData = await c.req.formData()
      const file = formData.get('audio') as File | null
      if (!file) return c.json({ error: 'No audio file provided' }, 400)
      audioBuffer = Buffer.from(await file.arrayBuffer())
      duration = parseInt(formData.get('duration') as string || '0', 10)
    } else {
      audioBuffer = Buffer.from(await c.req.arrayBuffer())
      duration = parseInt(c.req.header('x-recording-duration') || '0', 10)
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
        const workspace = await db.workspace.findFirst()
        if (!workspace) return c.json({ error: 'No workspace found' }, 400)

        const title = formatMeetingTitle(new Date())
        const meeting = await db.meeting.create({
          data: {
            title,
            audioPath: webmPath,
            duration: duration || null,
            status: 'transcribing',
            workspaceId: workspace.id,
          },
        })

        transcribeMeeting(meeting.id, webmPath, { preferLocal: false }).catch((err) => {
          console.error(`[Meetings] Transcription failed for ${meeting.id}:`, err)
        })

        return c.json({ meeting }, 201)
      }
    }

    const workspace = await db.workspace.findFirst()
    if (!workspace) return c.json({ error: 'No workspace found' }, 400)

    const title = formatMeetingTitle(new Date())
    const meeting = await db.meeting.create({
      data: {
        title,
        audioPath,
        duration: duration || null,
        status: 'transcribing',
        workspaceId: workspace.id,
      },
    })

    transcribeMeeting(meeting.id, audioPath).catch((err) => {
      console.error(`[Meetings] Transcription failed for ${meeting.id}:`, err)
    })

    return c.json({ meeting }, 201)
  } catch (err: any) {
    console.error('[Meetings] Upload error:', err)
    return c.json({ error: err.message }, 500)
  }
})

// Get a single meeting with transcript
meetingRoutes.get('/api/local/meetings/:id', async (c) => {
  try {
    const { id } = c.req.param()
    const meeting = await db.meeting.findUnique({
      where: { id },
      include: {
        project: { select: { id: true, name: true } },
      },
    })

    if (!meeting) return c.json({ error: 'Meeting not found' }, 404)

    return c.json({ meeting })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// Create a meeting record (called after recording stops)
meetingRoutes.post('/api/local/meetings', async (c) => {
  try {
    const body = await c.req.json<{
      audioPath: string
      duration?: number
      title?: string
      projectId?: string
    }>()

    const workspace = await db.workspace.findFirst()
    if (!workspace) return c.json({ error: 'No workspace found' }, 400)

    const title = body.title || formatMeetingTitle(new Date())

    const meeting = await db.meeting.create({
      data: {
        title,
        audioPath: body.audioPath,
        duration: body.duration || null,
        status: 'transcribing',
        projectId: body.projectId || null,
        workspaceId: workspace.id,
      },
    })

    transcribeMeeting(meeting.id, body.audioPath).catch((err) => {
      console.error(`[Meetings] Transcription failed for ${meeting.id}:`, err)
    })

    return c.json({ meeting }, 201)
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// Re-trigger transcription
meetingRoutes.post('/api/local/meetings/:id/transcribe', async (c) => {
  try {
    const { id } = c.req.param()
    const body = await c.req.json<{ model?: string; useCloud?: boolean }>().catch(() => ({} as { model?: string; useCloud?: boolean }))

    const meeting = await db.meeting.findUnique({ where: { id } })
    if (!meeting) return c.json({ error: 'Meeting not found' }, 404)

    await db.meeting.update({
      where: { id },
      data: { status: 'transcribing', transcript: null, summary: null },
    })

    transcribeMeeting(id, meeting.audioPath, {
      model: body.model,
      preferLocal: !body.useCloud,
    }).catch((err) => {
      console.error(`[Meetings] Re-transcription failed for ${id}:`, err)
    })

    return c.json({ ok: true })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// Attach meeting to a project (writes transcript file to project workspace)
meetingRoutes.post('/api/local/meetings/:id/attach', async (c) => {
  try {
    const { id } = c.req.param()
    const { projectId } = await c.req.json<{ projectId: string }>()

    const meeting = await db.meeting.findUnique({ where: { id } })
    if (!meeting) return c.json({ error: 'Meeting not found' }, 404)

    const updated = await db.meeting.update({
      where: { id },
      data: { projectId },
    })

    if (meeting.transcript) {
      writeTranscriptToProject(projectId, meeting)
    }

    return c.json({ meeting: updated })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// Update meeting (title, etc.)
meetingRoutes.put('/api/local/meetings/:id', async (c) => {
  try {
    const { id } = c.req.param()
    const body = await c.req.json<{ title?: string; projectId?: string | null }>()

    const meeting = await db.meeting.findUnique({ where: { id } })
    if (!meeting) return c.json({ error: 'Meeting not found' }, 404)

    const updated = await db.meeting.update({
      where: { id },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
      },
    })

    return c.json({ meeting: updated })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// Delete a meeting + its audio file
meetingRoutes.delete('/api/local/meetings/:id', async (c) => {
  try {
    const { id } = c.req.param()

    const meeting = await db.meeting.findUnique({ where: { id } })
    if (!meeting) return c.json({ error: 'Meeting not found' }, 404)

    if (meeting.audioPath && existsSync(meeting.audioPath)) {
      try { unlinkSync(meeting.audioPath) } catch (err) {
        console.warn(`[Meetings] Failed to delete audio file: ${meeting.audioPath}`, err)
      }
    }

    // Clean up resampled 16k file and JSON transcript if they exist
    const resampledPath = meeting.audioPath?.replace(/\.wav$/, '-16k.wav')
    if (resampledPath && existsSync(resampledPath)) {
      try { unlinkSync(resampledPath) } catch {}
    }
    const jsonPath = meeting.audioPath?.replace(/\.[^.]+$/, '.json')
    if (jsonPath && existsSync(jsonPath)) {
      try { unlinkSync(jsonPath) } catch {}
    }

    await db.meeting.delete({ where: { id } })

    return c.json({ ok: true })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// --- Helpers ---

const WAV_HEADER_SIZE = 44
const MIN_AUDIO_DURATION_SECONDS = 0.1

function getAudioDuration(audioPath: string): number {
  try {
    const stat = statSync(audioPath)
    if (stat.size <= WAV_HEADER_SIZE) return 0

    const header = Buffer.alloc(WAV_HEADER_SIZE)
    const fd = readFileSync(audioPath)
    fd.copy(header, 0, 0, WAV_HEADER_SIZE)

    if (header.toString('ascii', 0, 4) !== 'RIFF') return -1
    if (header.toString('ascii', 8, 12) !== 'WAVE') return -1

    const channels = header.readUInt16LE(22)
    const sampleRate = header.readUInt32LE(24)
    const bitsPerSample = header.readUInt16LE(34)
    const dataSize = header.readUInt32LE(40)

    const bytesPerSample = (bitsPerSample / 8) * channels
    if (bytesPerSample === 0 || sampleRate === 0) return 0
    return dataSize / (sampleRate * bytesPerSample)
  } catch {
    return -1
  }
}

async function getMeetingConfig(): Promise<{ diarizationEnabled: boolean; whisperModel: string }> {
  try {
    const rows = await db.localConfig.findMany({
      where: { key: { in: ['MEETING_DIARIZATION_ENABLED', 'MEETING_WHISPER_MODEL'] } },
    })
    const map: Record<string, string> = {}
    for (const r of rows) map[r.key] = r.value
    return {
      diarizationEnabled: (map.MEETING_DIARIZATION_ENABLED ?? 'true') === 'true',
      whisperModel: map.MEETING_WHISPER_MODEL ?? 'base.en',
    }
  } catch {
    return { diarizationEnabled: true, whisperModel: 'base.en' }
  }
}

async function transcribeMeeting(
  meetingId: string,
  audioPath: string,
  options?: { model?: string; preferLocal?: boolean },
): Promise<void> {
  try {
    if (!existsSync(audioPath)) {
      console.warn(`[Meetings] Audio file not found for ${meetingId}: ${audioPath}`)
      await db.meeting.update({
        where: { id: meetingId },
        data: { status: 'ready', transcript: JSON.stringify({ text: '', segments: [], language: 'en', error: 'Audio file not found' }) },
      }).catch(() => {})
      return
    }

    const fileSize = statSync(audioPath).size
    const duration = getAudioDuration(audioPath)
    // duration === -1 means non-WAV file (e.g. webm) — skip the length check
    // and let the transcription service handle it
    if (duration >= 0 && duration < MIN_AUDIO_DURATION_SECONDS) {
      console.warn(`[Meetings] Audio too short for ${meetingId}: ${duration.toFixed(2)}s (need >=${MIN_AUDIO_DURATION_SECONDS}s), file size: ${fileSize} bytes`)
      // Only reject if the file is actually tiny (< 1KB). A valid WAV with
      // real audio will have a meaningful file size even if header parsing
      // computes a short duration due to edge cases.
      if (fileSize < 1024) {
        await db.meeting.update({
          where: { id: meetingId },
          data: {
            status: 'ready',
            transcript: JSON.stringify({ text: '', segments: [], language: 'en', error: 'Audio file is empty or too short to transcribe' }),
          },
        }).catch(() => {})
        return
      }
      console.log(`[Meetings] File is ${fileSize} bytes — proceeding with transcription despite short WAV duration`)
    }

    const config = await getMeetingConfig()
    const model = options?.model || config.whisperModel

    // Run transcription and (optionally) diarization in parallel
    const shouldDiarize = config.diarizationEnabled && isDiarizationAvailable()

    const [transcriptionResult, diarizationResult] = await Promise.all([
      transcribe(audioPath, { model, preferLocal: options?.preferLocal ?? true }),
      shouldDiarize
        ? diarize(audioPath).catch((err) => {
            console.warn(`[Meetings] Diarization failed (continuing without): ${err.message}`)
            return null
          })
        : Promise.resolve(null),
    ])

    let segments = transcriptionResult.segments

    // Merge speaker labels into transcript segments
    if (diarizationResult && diarizationResult.segments.length > 0) {
      const hasTimedSegments = segments.length > 1 || (segments.length === 1 && segments[0].end > 0)
      if (hasTimedSegments) {
        segments = mergeTranscriptWithSpeakers(segments, diarizationResult.segments)
      } else {
        segments = splitTextBySpeakers(transcriptionResult.text, diarizationResult.segments)
      }
    }

    const transcriptJson = JSON.stringify({
      text: transcriptionResult.text,
      segments,
      language: transcriptionResult.language,
      numSpeakers: diarizationResult?.numSpeakers || 0,
    })

    const updated = await db.meeting.update({
      where: { id: meetingId },
      data: {
        transcript: transcriptJson,
        duration: Math.round(transcriptionResult.duration) || undefined,
        status: 'ready',
      },
    })

    if (updated.projectId) {
      writeTranscriptToProject(updated.projectId, updated)
    }

    console.log(
      `[Meetings] Transcription complete for ${meetingId}: ${segments.length} segments` +
      (diarizationResult ? `, ${diarizationResult.numSpeakers} speakers` : ''),
    )
  } catch (err: any) {
    console.error(`[Meetings] Transcription error for ${meetingId}:`, err)
    await db.meeting.update({
      where: { id: meetingId },
      data: {
        status: 'error',
        transcript: JSON.stringify({ text: '', segments: [], language: 'en', error: err.message || 'Transcription failed' }),
      },
    }).catch(() => {})
  }
}

function writeTranscriptToProject(projectId: string, meeting: any): void {
  const workspacesDir = process.env.WORKSPACES_DIR
  if (!workspacesDir) return

  const projectDir = join(workspacesDir, projectId)
  if (!existsSync(projectDir)) return

  const meetingsDir = join(projectDir, '.meetings')
  mkdirSync(meetingsDir, { recursive: true })

  let parsed: { text: string; segments?: { start: number; end: number; text: string; speaker?: string }[]; numSpeakers?: number } | null = null
  try {
    parsed = JSON.parse(meeting.transcript)
  } catch {
    parsed = { text: meeting.transcript }
  }

  if (!parsed) return

  const date = new Date(meeting.createdAt)
  const dateStr = date.toISOString().split('T')[0]
  const filename = `${dateStr}-${meeting.id}.md`

  let md = `# ${meeting.title || 'Meeting Transcript'}\n\n`
  md += `**Date:** ${date.toLocaleString()}\n`
  if (meeting.duration) md += `**Duration:** ${Math.floor(meeting.duration / 60)}m ${meeting.duration % 60}s\n`
  if (parsed.numSpeakers && parsed.numSpeakers > 0) {
    md += `**Speakers:** ${parsed.numSpeakers}\n`
  }
  md += '\n---\n\n'

  if (parsed.segments && parsed.segments.length > 0) {
    for (const seg of parsed.segments) {
      const ts = formatTimestamp(seg.start)
      if (seg.speaker) {
        md += `**[${ts}] ${seg.speaker.toUpperCase()}:** ${seg.text}\n\n`
      } else {
        md += `**[${ts}]** ${seg.text}\n\n`
      }
    }
  } else {
    md += parsed.text + '\n'
  }

  writeFileSync(join(meetingsDir, filename), md, 'utf-8')
  console.log(`[Meetings] Transcript written to ${join(meetingsDir, filename)}`)
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function formatMeetingTitle(date: Date): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }
  return `Meeting - ${date.toLocaleDateString('en-US', options)}`
}

