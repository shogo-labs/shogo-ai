// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Personal-workspace meetings. Mounted twice with different `authorize`
 * strategies, like `workspace-agent.ts`: under `/api` for the app (session +
 * membership) and under `/api/internal` for the workspace runtime, so the
 * personal companion's meeting tools read the same data the UI shows.
 */

import { Hono } from 'hono'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { prisma } from '../lib/prisma'
import { getWorkspaceKind } from '../services/workspace.service'
import {
  LIVE_CHUNK_MAX_BYTES,
  MAX_MEETING_NOTES_CHARS,
  MEETING_LIST_SELECT,
  appendLiveTranscript,
  cleanMeetingNotes,
  defaultMeetingTitle,
  enhanceMeeting,
  findRecordingDraft,
  friendlyMeetingError,
  isInterruptedDraft,
  isUsableTemplateId,
  listMeetingTemplates,
  meetingToMarkdown,
  newShareToken,
  parseLiveChunks,
  removeAudioFiles,
  searchMeetings,
  serializeMeeting,
  serializeSharedMeeting,
  transcribeMeeting,
  upsertRecordingDraft,
  validateTemplateInput,
} from '../services/meeting.service'
import { isBuiltinTemplateId } from '../services/meeting-templates'
import type { WorkspaceAgentAuthorize, WorkspaceAgentAuthContext } from './workspace-agent'

const db = prisma

/** Whisper's upload limit. Mobile records small mono AAC to stay under it. */
export const MAX_MEETING_UPLOAD_BYTES = 25 * 1024 * 1024

const isLocalMode = () => process.env.SHOGO_LOCAL_MODE === 'true'

export interface WorkspaceMeetingRoutesConfig {
  authorize: WorkspaceAgentAuthorize
}

function error(c: any, status: number, code: string, message: string) {
  return c.json({ error: { code, message } }, status)
}

function invalidTemplate(c: any) {
  return error(c, 400, 'invalid_template', 'Pick a built-in template or one from this workspace')
}

/** A `limit` query value as an integer in [1, max]; `fallback` when absent or malformed. */
export function clampLimit(value: string | undefined, fallback: number, max: number): number {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : fallback
}

function recordingsDir(): string {
  if (!isLocalMode()) {
    const dir = join(tmpdir(), 'shogo-meeting-uploads')
    mkdirSync(dir, { recursive: true })
    return dir
  }
  const home = process.env.HOME || process.env.USERPROFILE || tmpdir()
  const dir = join(process.env.SHOGO_DATA_DIR || join(home, '.shogo'), 'recordings')
  mkdirSync(dir, { recursive: true })
  return dir
}

const AUDIO_EXTENSIONS: Record<string, string> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
}

export function audioExtension(file: { type?: string; name?: string }): string | null {
  const byType = file.type ? AUDIO_EXTENSIONS[file.type.split(';')[0].trim().toLowerCase()] : undefined
  if (byType) return byType
  const ext = file.name?.split('.').pop()?.toLowerCase()
  return ext && ['wav', 'webm', 'm4a', 'mp4', 'mp3', 'ogg', 'caf'].includes(ext) ? (ext === 'mp4' ? 'm4a' : ext) : null
}

export function workspaceMeetingRoutes(config: WorkspaceMeetingRoutesConfig): Hono {
  const router = new Hono()
  const base = '/workspaces/:workspaceId/meetings'

  /** Authorize, then require a personal workspace: meetings are private to one person. */
  async function scope(c: any): Promise<WorkspaceAgentAuthContext | Response> {
    const auth = await config.authorize(c)
    if (auth instanceof Response) return auth
    if ((await getWorkspaceKind(auth.workspaceId)) !== 'personal') {
      return error(c, 404, 'not_personal', 'Meetings live in your personal workspace')
    }
    return auth
  }

  async function loadMeeting(c: any, auth: WorkspaceAgentAuthContext) {
    const meeting = await db.meeting.findUnique({ where: { id: c.req.param('meetingId') } })
    return meeting && meeting.workspaceId === auth.workspaceId ? meeting : null
  }

  // ── List + search ──────────────────────────────────────────────────────
  router.get(base, async (c) => {
    const auth = await scope(c)
    if (auth instanceof Response) return auth
    const q = c.req.query('q')?.trim()
    if (q) {
      return c.json({ results: await searchMeetings(auth.workspaceId, q, { limit: clampLimit(c.req.query('limit'), 20, 50) }) })
    }
    const take = clampLimit(c.req.query('limit'), 100, 200)
    const meetings = await db.meeting.findMany({
      where: { workspaceId: auth.workspaceId },
      orderBy: { createdAt: 'desc' },
      take,
      select: MEETING_LIST_SELECT,
    })
    return c.json({ meetings })
  })

  router.get(`${base}/search`, async (c) => {
    const auth = await scope(c)
    if (auth instanceof Response) return auth
    const q = c.req.query('q')?.trim() ?? ''
    const sinceDays = Number(c.req.query('sinceDays'))
    const since = Number.isFinite(sinceDays) && sinceDays > 0 ? new Date(Date.now() - sinceDays * 86_400_000) : undefined
    const results = await searchMeetings(auth.workspaceId, q, { limit: clampLimit(c.req.query('limit'), 10, 50), since })
    return c.json({ results })
  })

  // ── Templates (static paths before /:meetingId) ────────────────────────
  router.get(`${base}/templates`, async (c) => {
    const auth = await scope(c)
    if (auth instanceof Response) return auth
    return c.json({ templates: await listMeetingTemplates(auth.workspaceId) })
  })

  router.post(`${base}/templates`, async (c) => {
    const auth = await scope(c)
    if (auth instanceof Response) return auth
    const body = await c.req.json().catch(() => ({}))
    const parsed = validateTemplateInput(body, false)
    if (!parsed.ok) return error(c, 400, 'invalid_template', parsed.error)
    const template = await db.meetingTemplate.create({
      data: { ...parsed.data, workspaceId: auth.workspaceId, createdBy: auth.userId ?? null },
    })
    return c.json({ template: { ...template, builtIn: false } }, 201)
  })

  router.patch(`${base}/templates/:templateId`, async (c) => {
    const auth = await scope(c)
    if (auth instanceof Response) return auth
    const templateId = c.req.param('templateId')
    if (isBuiltinTemplateId(templateId)) return error(c, 400, 'builtin_template', 'Built-in templates cannot be edited')
    const existing = await db.meetingTemplate.findFirst({ where: { id: templateId, workspaceId: auth.workspaceId } })
    if (!existing) return error(c, 404, 'not_found', 'Template not found')
    const parsed = validateTemplateInput(await c.req.json().catch(() => ({})), true)
    if (!parsed.ok) return error(c, 400, 'invalid_template', parsed.error)
    const template = await db.meetingTemplate.update({ where: { id: templateId }, data: parsed.data })
    return c.json({ template: { ...template, builtIn: false } })
  })

  router.delete(`${base}/templates/:templateId`, async (c) => {
    const auth = await scope(c)
    if (auth instanceof Response) return auth
    const templateId = c.req.param('templateId')
    if (isBuiltinTemplateId(templateId)) return error(c, 400, 'builtin_template', 'Built-in templates cannot be deleted')
    const result = await db.meetingTemplate.deleteMany({ where: { id: templateId, workspaceId: auth.workspaceId } })
    if (result.count === 0) return error(c, 404, 'not_found', 'Template not found')
    return c.json({ ok: true })
  })

  // ── Desktop recording drafts: notes typed in the island while recording ─
  router.get(`${base}/recordings/:recordingId`, async (c) => {
    const auth = await scope(c)
    if (auth instanceof Response) return auth
    const meeting = await findRecordingDraft(auth.workspaceId, c.req.param('recordingId'))
    if (!meeting) return error(c, 404, 'not_found', 'Meeting not found')
    return c.json({ meeting: serializeMeeting(meeting) })
  })

  const saveRecordingDraft = async (c: any) => {
    const auth = await scope(c)
    if (auth instanceof Response) return auth
    const body = await c.req.json().catch(() => ({}))
    const meeting = await upsertRecordingDraft(
      { workspaceId: auth.workspaceId, userId: auth.userId ?? null },
      c.req.param('recordingId'),
      body,
    )
    return c.json({ meeting: serializeMeeting(meeting) })
  }
  router.put(`${base}/recordings/:recordingId`, saveRecordingDraft)
  router.patch(`${base}/recordings/:recordingId`, saveRecordingDraft)

  /** A few seconds of audio from a recording in progress, for the live transcript. */
  router.post(`${base}/recordings/:recordingId/live`, async (c) => {
    const auth = await scope(c)
    if (auth instanceof Response) return auth
    return handleLiveChunk(c, { workspaceId: auth.workspaceId, userId: auth.userId ?? null }, c.req.param('recordingId'))
  })

  // ── Create ─────────────────────────────────────────────────────────────
  /** A meeting with typed notes only (no audio), e.g. a quick note after a hallway chat. */
  router.post(base, async (c) => {
    const auth = await scope(c)
    if (auth instanceof Response) return auth
    const body = await c.req.json().catch(() => ({}))
    const notes = cleanMeetingNotes(body.notes)
    if (!notes?.trim()) return error(c, 400, 'notes_required', 'Add some notes to create a meeting without audio')
    const templateId = typeof body.templateId === 'string' ? body.templateId : null
    if (templateId && !(await isUsableTemplateId(auth.workspaceId, templateId))) return invalidTemplate(c)
    const meeting = await db.meeting.create({
      data: {
        workspaceId: auth.workspaceId,
        userId: auth.userId ?? null,
        title: typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 200) : defaultMeetingTitle(new Date()),
        notes,
        status: 'ready',
        source: 'upload',
        templateId,
      },
    })
    void enhanceMeeting(meeting.id).catch(() => {})
    return c.json({ meeting: serializeMeeting(meeting) }, 201)
  })

  /** Audio from the phone or a browser, transcribed server-side. */
  router.post(`${base}/upload`, async (c) => {
    const auth = await scope(c)
    if (auth instanceof Response) return auth
    const declared = Number(c.req.header('content-length') || 0)
    if (declared > MAX_MEETING_UPLOAD_BYTES + 1024 * 1024) {
      return error(c, 413, 'too_large', 'Recording is too large to transcribe (25 MB limit)')
    }
    let form: FormData
    try {
      form = await c.req.formData()
    } catch {
      return error(c, 400, 'invalid_upload', 'Expected multipart form data with an "audio" file')
    }
    const file = form.get('audio')
    if (!file || typeof file === 'string') return error(c, 400, 'invalid_upload', 'No audio file provided')
    const ext = audioExtension(file as File)
    if (!ext) return error(c, 415, 'unsupported_audio', 'Unsupported audio format')
    const buffer = Buffer.from(await (file as File).arrayBuffer())
    if (buffer.length === 0) return error(c, 400, 'empty_audio', 'The recording is empty')
    if (buffer.length > MAX_MEETING_UPLOAD_BYTES) {
      return error(c, 413, 'too_large', 'Recording is too large to transcribe (25 MB limit)')
    }

    const id = `mrec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const sessionDir = join(recordingsDir(), id)
    mkdirSync(sessionDir, { recursive: true })
    const audioPath = join(sessionDir, `audio.${ext}`)
    writeFileSync(audioPath, buffer)

    const source = form.get('source') === 'mobile' ? 'mobile' : 'upload'
    const title = String(form.get('title') || '').trim()
    const duration = Number.parseInt(String(form.get('duration') || '0'), 10) || null
    const notes = cleanMeetingNotes(String(form.get('notes') || '')) || null
    const recordingId = String(form.get('recordingId') || '').trim()
    // Finish the draft the live transcript was written into, if there is one.
    const draft = recordingId ? await findRecordingDraft(auth.workspaceId, recordingId) : null
    const meeting =
      draft && (draft.status === 'recording' || isInterruptedDraft(draft))
        ? await db.meeting.update({
            where: { id: draft.id },
            data: {
              audioPath,
              duration,
              status: 'transcribing',
              source,
              ...(title ? { title: title.slice(0, 200) } : {}),
              ...(notes ? { notes } : {}),
            },
          })
        : await db.meeting.create({
            data: {
              workspaceId: auth.workspaceId,
              userId: auth.userId ?? null,
              title: title ? title.slice(0, 200) : defaultMeetingTitle(new Date()),
              notes,
              audioPath,
              duration,
              status: 'transcribing',
              source,
            },
          })
    void transcribeMeeting(meeting.id, audioPath, {
      deleteAudioAfter: !isLocalMode(),
      liveChunks: meeting.id === draft?.id ? parseLiveChunks(form.get('liveChunks')) : undefined,
    })
    return c.json({ meeting: serializeMeeting(meeting) }, 201)
  })

  // ── Single meeting ─────────────────────────────────────────────────────
  router.get(`${base}/:meetingId`, async (c) => {
    const auth = await scope(c)
    if (auth instanceof Response) return auth
    const meeting = await loadMeeting(c, auth)
    if (!meeting) return error(c, 404, 'not_found', 'Meeting not found')
    const serialized = serializeMeeting(meeting)
    if (c.req.query('transcript') === 'false') delete (serialized as any).transcript
    return c.json({ meeting: serialized })
  })

  router.get(`${base}/:meetingId/markdown`, async (c) => {
    const auth = await scope(c)
    if (auth instanceof Response) return auth
    const meeting = await loadMeeting(c, auth)
    if (!meeting) return error(c, 404, 'not_found', 'Meeting not found')
    const includeTranscript = c.req.query('transcript') !== 'false'
    return c.json({ markdown: meetingToMarkdown(meeting, { includeTranscript }) })
  })

  router.patch(`${base}/:meetingId`, async (c) => {
    const auth = await scope(c)
    if (auth instanceof Response) return auth
    const meeting = await loadMeeting(c, auth)
    if (!meeting) return error(c, 404, 'not_found', 'Meeting not found')
    const body = await c.req.json().catch(() => ({}))
    const data: Record<string, unknown> = {}
    if (typeof body.title === 'string' && body.title.trim()) data.title = body.title.trim().slice(0, 200)
    const notes = cleanMeetingNotes(body.notes)
    if (notes !== undefined) data.notes = notes
    if (typeof body.enhancedNotes === 'string') data.enhancedNotes = body.enhancedNotes.slice(0, MAX_MEETING_NOTES_CHARS)
    if (typeof body.templateId === 'string') {
      if (!(await isUsableTemplateId(auth.workspaceId, body.templateId))) return invalidTemplate(c)
      data.templateId = body.templateId
    }
    if (Array.isArray(body.actionItems)) {
      data.actionItems = JSON.stringify(
        body.actionItems
          .filter((item: any) => item && typeof item.text === 'string' && item.text.trim())
          .slice(0, 100)
          .map((item: any) => ({
            text: String(item.text).slice(0, 500),
            ...(typeof item.owner === 'string' && item.owner ? { owner: item.owner.slice(0, 100) } : {}),
            done: item.done === true,
          })),
      )
    }
    const updated = await db.meeting.update({ where: { id: meeting.id }, data })
    return c.json({ meeting: serializeMeeting(updated) })
  })

  router.post(`${base}/:meetingId/enhance`, async (c) => {
    const auth = await scope(c)
    if (auth instanceof Response) return auth
    const meeting = await loadMeeting(c, auth)
    if (!meeting) return error(c, 404, 'not_found', 'Meeting not found')
    if (meeting.status === 'recording' || meeting.status === 'transcribing') {
      return error(c, 409, 'not_ready', 'Notes are enhanced once the transcript is ready')
    }
    const body = await c.req.json().catch(() => ({}))
    const templateId = typeof body.templateId === 'string' ? body.templateId : undefined
    if (templateId && !(await isUsableTemplateId(auth.workspaceId, templateId))) return invalidTemplate(c)
    const wait = body.wait === true
    const run = enhanceMeeting(meeting.id, { templateId })
    if (wait) {
      await run
      const updated = await db.meeting.findUnique({ where: { id: meeting.id } })
      if (!updated) return error(c, 404, 'not_found', 'Meeting not found')
      return c.json({ meeting: serializeMeeting(updated) })
    }
    void run.catch(() => {})
    return c.json({ ok: true, enhanceStatus: 'running' }, 202)
  })

  router.post(`${base}/:meetingId/share`, async (c) => {
    const auth = await scope(c)
    if (auth instanceof Response) return auth
    if (isLocalMode()) {
      return error(c, 400, 'share_unavailable', 'Share links need Shogo Cloud. Copy the notes instead.')
    }
    const meeting = await loadMeeting(c, auth)
    if (!meeting) return error(c, 404, 'not_found', 'Meeting not found')
    if (!meeting.enhancedNotes) return error(c, 409, 'not_ready', 'Share once the notes are ready')
    const shareToken = meeting.shareToken ?? newShareToken()
    await db.meeting.update({ where: { id: meeting.id }, data: { shareToken, sharedAt: meeting.sharedAt ?? new Date() } })
    return c.json({ shareToken })
  })

  router.delete(`${base}/:meetingId/share`, async (c) => {
    const auth = await scope(c)
    if (auth instanceof Response) return auth
    const meeting = await loadMeeting(c, auth)
    if (!meeting) return error(c, 404, 'not_found', 'Meeting not found')
    await db.meeting.update({ where: { id: meeting.id }, data: { shareToken: null, sharedAt: null } })
    return c.json({ ok: true })
  })

  router.delete(`${base}/:meetingId`, async (c) => {
    const auth = await scope(c)
    if (auth instanceof Response) return auth
    const meeting = await loadMeeting(c, auth)
    if (!meeting) return error(c, 404, 'not_found', 'Meeting not found')
    removeAudioFiles(meeting.audioPath)
    await db.meeting.delete({ where: { id: meeting.id } })
    return c.json({ ok: true })
  })

  return router
}

/**
 * Shared by the workspace route (app sessions) and the local route (the
 * desktop recorder, which has no session). Accepts multipart `audio` + `start`
 * + `seq`, or a raw WAV body with `x-live-start` / `x-live-seq` headers.
 */
export async function handleLiveChunk(
  c: any,
  owner: { workspaceId: string; userId: string | null },
  recordingId: string,
): Promise<Response> {
  const declared = Number(c.req.header('content-length') || 0)
  if (declared > LIVE_CHUNK_MAX_BYTES + 64 * 1024) return error(c, 413, 'too_large', 'Live audio chunk is too large')
  let audio: Buffer
  let start: number
  let seq: number
  const contentType = c.req.header('content-type') || ''
  try {
    if (contentType.includes('multipart/form-data')) {
      const form = await c.req.formData()
      const file = form.get('audio')
      if (!file || typeof file === 'string') return error(c, 400, 'invalid_chunk', 'No audio in live chunk')
      audio = Buffer.from(await (file as File).arrayBuffer())
      start = Number(form.get('start'))
      seq = Number(form.get('seq'))
    } else {
      audio = Buffer.from(await c.req.arrayBuffer())
      start = Number(c.req.header('x-live-start'))
      seq = Number(c.req.header('x-live-seq'))
    }
  } catch {
    return error(c, 400, 'invalid_chunk', 'Could not read the live audio chunk')
  }

  const draft = await upsertRecordingDraft(owner, recordingId, {})
  try {
    const result = await appendLiveTranscript(draft.id, { audio, start, seq })
    if (!result.ok) {
      return result.reason === 'invalid'
        ? error(c, 400, 'invalid_chunk', 'Live audio chunk must be a WAV with a start offset and sequence number')
        : result.reason === 'disabled'
          ? error(c, 409, 'meetings_disabled', 'Meetings and transcription are disabled')
        : error(c, 409, 'not_recording', 'This recording has already finished')
    }
    return c.json({ meetingId: draft.id, segment: result.segment, transcript: result.transcript })
  } catch (err: any) {
    console.warn(`[Meetings] Live transcription failed for ${draft.id}:`, err?.message ?? err)
    return error(c, 503, 'transcription_unavailable', friendlyMeetingError('transcript', err))
  }
}

/** Public, unauthenticated read of a shared meeting's notes. */
export function sharedMeetingRoutes(): Hono {
  const router = new Hono()
  router.get('/shared-meetings/:token', async (c) => {
    const token = c.req.param('token')
    if (!token || token.length < 16) return error(c, 404, 'not_found', 'This link is invalid or was revoked')
    const meeting = await db.meeting.findUnique({ where: { shareToken: token } })
    if (!meeting) return error(c, 404, 'not_found', 'This link is invalid or was revoked')
    return c.json({ meeting: serializeSharedMeeting(meeting) })
  })
  return router
}
