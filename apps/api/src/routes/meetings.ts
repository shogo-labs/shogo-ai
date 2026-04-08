// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { transcribe, isLocalTranscriptionAvailable } from '../services/transcription.service'
import {
  startRecording as startRec,
  stopRecording as stopRec,
  getRecordingStatus as getRecStatus,
} from '../services/recording.service'
import { existsSync, unlinkSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { execSync } from 'child_process'

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
] as const

const MEETING_CONFIG_DEFAULTS: Record<string, string> = {
  MEETING_AUTO_DETECT: 'true',
  MEETING_AUTO_RECORD: 'false',
  MEETING_AUTO_RECORD_CONFIRM_COUNT: '0',
  MEETING_GRACE_PERIOD_SECONDS: '10',
  MEETING_AUTO_STOP_SECONDS: '60',
  MEETING_WHISPER_MODEL: 'base.en',
  MEETING_USE_CLOUD_TRANSCRIPTION: 'false',
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

// Transcription status/capability check (includes installed model info)
meetingRoutes.get('/api/local/meetings/transcription-status', async (c) => {
  const whisperDir = resolve(process.cwd(), 'apps', 'desktop', 'resources', 'whisper')
  const modelsDir = join(whisperDir, 'models')

  // Check for binary: local resources dir or system PATH (e.g. from brew)
  let binaryInstalled = existsSync(join(whisperDir, 'whisper-cli'))
  if (!binaryInstalled) {
    try {
      execSync('which whisper-cli', { encoding: 'utf-8' })
      binaryInstalled = true
    } catch {}
  }

  const ALL_MODELS = ['tiny.en', 'base.en', 'small.en', 'medium.en', 'tiny', 'base', 'small', 'medium']
  const installedModels: string[] = []
  for (const model of ALL_MODELS) {
    if (existsSync(join(modelsDir, `ggml-${model}.bin`))) {
      installedModels.push(model)
    }
  }

  return c.json({
    localAvailable: isLocalTranscriptionAvailable(),
    cloudAvailable: !!(process.env.OPENAI_API_KEY || process.env.AI_PROXY_URL),
    binaryInstalled,
    installedModels,
  })
})

const MODEL_URLS: Record<string, string> = {
  'tiny.en': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin',
  'tiny': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
  'base.en': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
  'base': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
  'small.en': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin',
  'small': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
  'medium.en': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en.bin',
  'medium': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin',
}

// Install whisper binary (via Homebrew on macOS) + download a model
meetingRoutes.post('/api/local/meetings/install-whisper', async (c) => {
  const { model = 'base.en' } = await c.req.json<{ model?: string }>().catch(() => ({ model: 'base.en' }))

  if (!MODEL_URLS[model]) {
    return c.json({ error: `Unknown model: ${model}` }, 400)
  }

  const whisperDir = resolve(process.cwd(), 'apps', 'desktop', 'resources', 'whisper')
  mkdirSync(join(whisperDir, 'models'), { recursive: true })

  const steps: string[] = []

  try {
    // 1. Ensure whisper-cli binary is available
    const localBinary = join(whisperDir, 'whisper-cli')
    let hasBinary = existsSync(localBinary)
    if (!hasBinary) {
      try {
        execSync('which whisper-cli', { encoding: 'utf-8' })
        hasBinary = true
        steps.push('Binary found in PATH')
      } catch {}
    }

    if (!hasBinary) {
      if (process.platform === 'darwin') {
        try {
          execSync('which brew', { encoding: 'utf-8' })
          steps.push('Installing whisper-cpp via Homebrew...')
          execSync('brew install whisper-cpp', { timeout: 300_000, encoding: 'utf-8' })
          steps.push('Binary installed via Homebrew')
        } catch (brewErr: any) {
          return c.json({
            error: 'Homebrew is required to install whisper-cpp on macOS. Install Homebrew first: https://brew.sh',
            steps,
          }, 400)
        }
      } else {
        return c.json({
          error: 'Automatic whisper install is only supported on macOS via Homebrew. On Linux, install whisper-cpp manually and ensure whisper-cli is in PATH.',
          steps,
        }, 400)
      }
    } else {
      steps.push('Binary already installed')
    }

    // 2. Download model if missing
    const modelPath = join(whisperDir, 'models', `ggml-${model}.bin`)
    if (!existsSync(modelPath)) {
      steps.push(`Downloading model ${model}...`)
      execSync(`curl -fSL -o "${modelPath}" "${MODEL_URLS[model]}"`, { timeout: 600_000 })
      steps.push(`Model ${model} installed`)
    } else {
      steps.push(`Model ${model} already installed`)
    }

    return c.json({ ok: true, steps })
  } catch (err: any) {
    return c.json({ error: err.message, steps }, 500)
  }
})

// =============================================================================
// Recording (server-side, for dev mode without Electron)
// =============================================================================

meetingRoutes.get('/api/local/meetings/recording/status', async (c) => {
  return c.json(getRecStatus())
})

meetingRoutes.post('/api/local/meetings/recording/start', async (c) => {
  try {
    const result = await startRec()
    return c.json(result)
  } catch (err: any) {
    return c.json({ error: err.message }, 400)
  }
})

meetingRoutes.post('/api/local/meetings/recording/stop', async (c) => {
  try {
    const result = await stopRec()
    if (!result) return c.json({ error: 'Not recording' }, 400)

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
  } catch (err: any) {
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

    // Kick off transcription in the background
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

    // Write transcript as a markdown file into the project workspace
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

    // Delete audio file
    if (meeting.audioPath && existsSync(meeting.audioPath)) {
      try {
        unlinkSync(meeting.audioPath)
      } catch (err) {
        console.warn(`[Meetings] Failed to delete audio file: ${meeting.audioPath}`, err)
      }
    }

    // Delete JSON transcript file if it exists
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

    const duration = getAudioDuration(audioPath)
    if (duration >= 0 && duration < MIN_AUDIO_DURATION_SECONDS) {
      console.warn(`[Meetings] Audio too short for ${meetingId}: ${duration.toFixed(2)}s (need >=${MIN_AUDIO_DURATION_SECONDS}s)`)
      await db.meeting.update({
        where: { id: meetingId },
        data: {
          status: 'ready',
          transcript: JSON.stringify({ text: '', segments: [], language: 'en', error: 'Audio file is empty or too short to transcribe' }),
        },
      }).catch(() => {})
      return
    }

    const result = await transcribe(audioPath, {
      model: options?.model,
      preferLocal: options?.preferLocal ?? true,
    })

    const transcriptJson = JSON.stringify({
      text: result.text,
      segments: result.segments,
      language: result.language,
    })

    const updated = await db.meeting.update({
      where: { id: meetingId },
      data: {
        transcript: transcriptJson,
        duration: Math.round(result.duration) || undefined,
        status: 'ready',
      },
    })

    if (updated.projectId) {
      writeTranscriptToProject(updated.projectId, updated)
    }

    console.log(`[Meetings] Transcription complete for ${meetingId}: ${result.segments.length} segments`)
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

  let parsed: { text: string; segments?: { start: number; end: number; text: string }[] } | null = null
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
  md += '\n---\n\n'

  if (parsed.segments && parsed.segments.length > 0) {
    for (const seg of parsed.segments) {
      const ts = formatTimestamp(seg.start)
      md += `**[${ts}]** ${seg.text}\n\n`
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
