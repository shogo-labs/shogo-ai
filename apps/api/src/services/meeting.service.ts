// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Meetings live in the user's personal workspace. This service owns the
 * pipeline every capture path shares (desktop recorder, mobile upload,
 * browser upload): transcribe, then merge the user's rough notes with the
 * transcript into enhanced notes using a template.
 */

import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { generateText } from 'ai'
import { prisma } from '../lib/prisma'
import { transcribe, type CloudTranscriptionAuth } from './transcription.service'
import {
  isDiarizationAvailable,
  diarize,
  mergeTranscriptWithSpeakers,
  splitTextBySpeakers,
} from './diarization.service'
import {
  BUILTIN_MEETING_TEMPLATES,
  DEFAULT_TEMPLATE_ID,
  findBuiltinTemplate,
  isBuiltinTemplateId,
  type MeetingTemplateView,
} from './meeting-templates'
import { resolveLanguageModel, DEFAULT_ASSISTANT_MODEL } from '../lib/resolve-language-model'
import { generateProxyToken } from '../lib/ai-proxy-token'
import { resolveApiBaseUrl } from '../lib/internal-proxy-config'

const db = prisma as any

const isLocalMode = () => process.env.SHOGO_LOCAL_MODE === 'true'

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

/**
 * The personal workspace meetings are recorded into. Desktop callers without
 * a session (the Electron recording bridge) resolve to the install's own
 * personal workspace; desktop is single-user.
 */
export async function resolvePersonalWorkspaceId(userId: string | null): Promise<string | null> {
  if (userId) {
    const member = await db.member.findFirst({
      where: { userId, workspace: { kind: 'personal' } },
      select: { workspaceId: true },
      orderBy: { createdAt: 'asc' },
    })
    if (member?.workspaceId) return member.workspaceId
  }
  if (!isLocalMode()) return null
  const personal = await db.workspace.findFirst({
    where: { kind: 'personal' },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  })
  if (personal) return personal.id
  const any = await db.workspace.findFirst({ select: { id: true }, orderBy: { createdAt: 'asc' } })
  return any?.id ?? null
}

export async function resolveLocalOwnerUserId(workspaceId: string): Promise<string | null> {
  const owner = await db.member.findFirst({
    where: { workspaceId, role: 'owner' },
    select: { userId: true },
    orderBy: { createdAt: 'asc' },
  })
  return owner?.userId ?? null
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export interface TranscriptSegment {
  start: number
  end: number
  text: string
  speaker?: string
}

export interface ParsedTranscript {
  text: string
  segments: TranscriptSegment[]
  language?: string
  numSpeakers?: number
  error?: string
}

export interface MeetingActionItem {
  text: string
  owner?: string
  done?: boolean
}

export function parseTranscript(raw: string | null | undefined): ParsedTranscript | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return {
      text: typeof parsed.text === 'string' ? parsed.text : '',
      segments: Array.isArray(parsed.segments) ? parsed.segments : [],
      language: parsed.language,
      numSpeakers: parsed.numSpeakers,
      error: typeof parsed.error === 'string' ? parsed.error : undefined,
    }
  } catch {
    return { text: String(raw), segments: [] }
  }
}

export function parseActionItems(raw: string | null | undefined): MeetingActionItem[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((item) => item && typeof item.text === 'string')
      : []
  } catch {
    return []
  }
}

export const MEETING_LIST_SELECT = {
  id: true,
  title: true,
  duration: true,
  status: true,
  enhanceStatus: true,
  source: true,
  app: true,
  projectId: true,
  shareToken: true,
  createdAt: true,
  updatedAt: true,
} as const

export function serializeMeeting(meeting: any) {
  const { actionItems, audioPath: _audioPath, ...rest } = meeting
  return {
    ...rest,
    actionItems: parseActionItems(actionItems),
    hasAudio: !!meeting.audioPath && existsSync(meeting.audioPath),
  }
}

function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** Plain-text transcript for prompts and exports, with speakers and timestamps. */
export function transcriptToText(transcript: ParsedTranscript | null, maxChars = Infinity): string {
  if (!transcript) return ''
  let text: string
  if (transcript.segments.length > 0) {
    const lines: string[] = []
    let lastSpeaker: string | undefined
    for (const seg of transcript.segments) {
      const body = (seg.text || '').trim()
      if (!body) continue
      if (seg.speaker && seg.speaker === lastSpeaker) {
        lines[lines.length - 1] += ` ${body}`
        continue
      }
      lastSpeaker = seg.speaker
      lines.push(`[${formatTimestamp(seg.start || 0)}]${seg.speaker ? ` ${seg.speaker}:` : ''} ${body}`)
    }
    text = lines.join('\n')
  } else {
    text = transcript.text.trim()
  }
  if (text.length <= maxChars) return text
  // Keep the start and end: openings set context, endings hold decisions.
  const half = Math.floor(maxChars / 2)
  return `${text.slice(0, half)}\n\n[... transcript truncated ...]\n\n${text.slice(-half)}`
}

function meetingDate(value: unknown): Date {
  const date = value instanceof Date ? value : new Date(value as string)
  return Number.isNaN(date.getTime()) ? new Date() : date
}

export function meetingToMarkdown(meeting: any, options: { includeTranscript?: boolean } = {}): string {
  const date = meetingDate(meeting.createdAt)
  let md = `# ${meeting.title || 'Meeting'}\n\n`
  md += `**Date:** ${date.toISOString()}\n`
  if (meeting.duration) md += `**Duration:** ${Math.floor(meeting.duration / 60)}m ${meeting.duration % 60}s\n`
  if (meeting.app) md += `**App:** ${meeting.app}\n`
  md += '\n'
  if (meeting.enhancedNotes) md += `${meeting.enhancedNotes.trim()}\n\n`
  if (meeting.notes?.trim()) md += `## My notes\n\n${meeting.notes.trim()}\n\n`
  if (options.includeTranscript) {
    const transcript = transcriptToText(parseTranscript(meeting.transcript))
    if (transcript) md += `## Transcript\n\n${transcript}\n`
  }
  return md
}

export function defaultMeetingTitle(date: Date, app?: string | null): string {
  const label = date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
  return app ? `${app} call - ${label}` : `Meeting - ${label}`
}

function isDefaultTitle(title: string | null | undefined): boolean {
  return !title || /^(Meeting|.+ call) - /.test(title)
}

// ---------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------

const WAV_HEADER_SIZE = 44
const MIN_AUDIO_DURATION_SECONDS = 0.1

function getWavDuration(audioPath: string): number {
  try {
    const stat = statSync(audioPath)
    if (stat.size <= WAV_HEADER_SIZE) return 0
    const header = readFileSync(audioPath).subarray(0, WAV_HEADER_SIZE)
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

async function getLocalMeetingConfig(): Promise<{ diarizationEnabled: boolean; whisperModel: string }> {
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

/** Proxy credentials that bill model and Whisper usage to the meeting's workspace. */
async function workspaceProxyAuth(workspaceId: string, userId: string | null): Promise<CloudTranscriptionAuth | null> {
  try {
    const token = await generateProxyToken('workspace', workspaceId, userId ?? undefined, 30 * 60 * 1000)
    return { proxyUrl: `${resolveApiBaseUrl()}/api/ai/v1`, proxyToken: token }
  } catch (err: any) {
    console.warn('[Meetings] Could not mint a workspace proxy token:', err?.message ?? err)
    return null
  }
}

/**
 * A sentence the meetings UI can show as-is. Provider errors carry status
 * codes, model ids and API paths that mean nothing to the person recording.
 */
export function friendlyMeetingError(kind: 'notes' | 'transcript', err: unknown): string {
  const raw = String((err as any)?.message ?? err ?? '')
  const noun = kind === 'notes' ? 'notes' : 'transcription'
  if (/No OpenAI API key or proxy configured|No model is configured/i.test(raw)) {
    return kind === 'notes'
      ? 'Writing notes needs Shogo Cloud or an AI provider key. Sign in or add a key in Settings, then try again.'
      : 'Transcription needs on-device transcription or Shogo Cloud. Set one up in Settings, then try again.'
  }
  if (/not supported|model.{0,40}not found|unknown model|does not exist/i.test(raw)) {
    return `The AI model for ${noun} isn't available on this machine. Sign in to Shogo Cloud or pick another model in Settings.`
  }
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid.{0,20}(token|key)/i.test(raw)) {
    return `Shogo couldn't authorize the ${noun} request. Sign in again, then retry.`
  }
  if (/\b(402|429)\b|rate.?limit|quota|insufficient|credits?/i.test(raw)) {
    return `You've hit your AI usage limit for now. Try again later or check your plan.`
  }
  if (/fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|timed? ?out|network|socket/i.test(raw)) {
    return `Couldn't reach the AI service for ${noun}. Check your connection and try again.`
  }
  if (/empty or too short|Audio file not found/i.test(raw)) return raw
  if (/returned empty notes/i.test(raw)) return 'The AI returned empty notes. Try again.'
  return kind === 'notes' ? 'Something went wrong writing notes. Try again.' : 'Something went wrong transcribing this recording. Try again.'
}

/**
 * Record a failed transcription. A live transcript captured while recording
 * is kept (with the error attached) so the meeting stays usable.
 */
async function markTranscriptError(meetingId: string, error: string): Promise<boolean> {
  const existing = await db.meeting.findUnique({ where: { id: meetingId }, select: { transcript: true } }).catch(() => null)
  const live = parseTranscript(existing?.transcript)
  const keepLive = !!live && (live.segments.length > 0 || !!live.text.trim())
  await db.meeting
    .update({
      where: { id: meetingId },
      data: keepLive
        ? {
            status: 'ready',
            transcript: JSON.stringify({ text: live!.text, segments: live!.segments, language: live!.language ?? 'en', error }),
          }
        : {
            status: 'error',
            transcript: JSON.stringify({ text: '', segments: [], language: 'en', error }),
          },
    })
    .catch(() => {})
  return keepLive
}

export interface TranscribeMeetingOptions {
  model?: string
  preferLocal?: boolean
  /** Delete the audio once transcribed. Cloud never keeps recordings. */
  deleteAudioAfter?: boolean
  /** Run enhancement once the transcript is ready. Defaults to true. */
  enhance?: boolean
}

export async function transcribeMeeting(
  meetingId: string,
  audioPath: string,
  options: TranscribeMeetingOptions = {},
): Promise<void> {
  try {
    if (!existsSync(audioPath)) {
      await db.meeting
        .update({
          where: { id: meetingId },
          data: {
            status: 'ready',
            transcript: JSON.stringify({ text: '', segments: [], language: 'en', error: 'Audio file not found' }),
          },
        })
        .catch(() => {})
      if (options.enhance !== false) void enhanceMeeting(meetingId).catch(() => {})
      return
    }

    const fileSize = statSync(audioPath).size
    const duration = getWavDuration(audioPath)
    // -1 means non-WAV (webm, m4a): let the transcriber decide.
    if (duration >= 0 && duration < MIN_AUDIO_DURATION_SECONDS && fileSize < 1024) {
      await db.meeting
        .update({
          where: { id: meetingId },
          data: {
            status: 'ready',
            transcript: JSON.stringify({
              text: '',
              segments: [],
              language: 'en',
              error: 'Audio file is empty or too short to transcribe',
            }),
          },
        })
        .catch(() => {})
      if (options.enhance !== false) void enhanceMeeting(meetingId).catch(() => {})
      return
    }

    const meeting = await db.meeting.findUnique({
      where: { id: meetingId },
      select: { workspaceId: true, userId: true },
    })
    if (!meeting) return

    const local = isLocalMode()
    const config = local ? await getLocalMeetingConfig() : { diarizationEnabled: false, whisperModel: 'base.en' }
    const model = options.model || config.whisperModel
    const preferLocal = local && (options.preferLocal ?? true)
    const cloudAuth = local ? undefined : (await workspaceProxyAuth(meeting.workspaceId, meeting.userId)) ?? undefined
    const shouldDiarize = local && config.diarizationEnabled && isDiarizationAvailable()

    const [transcriptionResult, diarizationResult] = await Promise.all([
      transcribe(audioPath, { model, preferLocal, cloudAuth }),
      shouldDiarize
        ? diarize(audioPath).catch((err) => {
            console.warn(`[Meetings] Diarization failed (continuing without): ${err.message}`)
            return null
          })
        : Promise.resolve(null),
    ])

    let segments = transcriptionResult.segments
    if (diarizationResult && diarizationResult.segments.length > 0) {
      const hasTimedSegments = segments.length > 1 || (segments.length === 1 && segments[0].end > 0)
      segments = hasTimedSegments
        ? mergeTranscriptWithSpeakers(segments, diarizationResult.segments)
        : splitTextBySpeakers(transcriptionResult.text, diarizationResult.segments)
    }

    const updated = await db.meeting.update({
      where: { id: meetingId },
      data: {
        transcript: JSON.stringify({
          text: transcriptionResult.text,
          segments,
          language: transcriptionResult.language,
          numSpeakers: diarizationResult?.numSpeakers || 0,
        }),
        duration: Math.round(transcriptionResult.duration) || undefined,
        status: 'ready',
        ...(options.deleteAudioAfter ? { audioPath: '' } : {}),
      },
    })
    if (options.deleteAudioAfter) removeAudioFiles(audioPath)
    if (updated.projectId) writeTranscriptToProject(updated.projectId, updated)

    console.log(
      `[Meetings] Transcription complete for ${meetingId}: ${segments.length} segments` +
        (diarizationResult ? `, ${diarizationResult.numSpeakers} speakers` : ''),
    )
    if (options.enhance !== false) {
      void enhanceMeeting(meetingId).catch((err) =>
        console.error(`[Meetings] Enhancement failed for ${meetingId}:`, err),
      )
    }
  } catch (err: any) {
    console.error(`[Meetings] Transcription error for ${meetingId}:`, err)
    const keptLive = await markTranscriptError(meetingId, friendlyMeetingError('transcript', err))
    if (options.deleteAudioAfter) removeAudioFiles(audioPath)
    if (keptLive && options.enhance !== false) void enhanceMeeting(meetingId).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Live transcription: short chunks transcribed while the meeting records.
// The full-file pass after stop replaces this preview.
// ---------------------------------------------------------------------------

export const LIVE_CHUNK_MAX_BYTES = 4 * 1024 * 1024
const LIVE_MAX_START_SECONDS = 8 * 60 * 60

export interface LiveChunkInput {
  audio: Buffer
  /** Offset of the chunk from the start of the recording, in seconds. */
  start: number
  /** Monotonic chunk number, so a retried upload isn't appended twice. */
  seq: number
}

export type LiveChunkResult =
  | { ok: true; segment: TranscriptSegment | null; transcript: ParsedTranscript }
  | { ok: false; reason: 'not_recording' | 'invalid' }

export async function appendLiveTranscript(meetingId: string, input: LiveChunkInput): Promise<LiveChunkResult> {
  if (
    input.audio.length <= WAV_HEADER_SIZE ||
    input.audio.length > LIVE_CHUNK_MAX_BYTES ||
    !Number.isFinite(input.start) ||
    input.start < 0 ||
    input.start > LIVE_MAX_START_SECONDS ||
    !Number.isInteger(input.seq) ||
    input.seq < 0
  ) {
    return { ok: false, reason: 'invalid' }
  }
  const meeting = await db.meeting.findUnique({
    where: { id: meetingId },
    select: { status: true, workspaceId: true, userId: true },
  })
  if (!meeting || meeting.status !== 'recording') return { ok: false, reason: 'not_recording' }

  const local = isLocalMode()
  const config = local ? await getLocalMeetingConfig() : { diarizationEnabled: false, whisperModel: 'base.en' }
  const cloudAuth = local ? undefined : (await workspaceProxyAuth(meeting.workspaceId, meeting.userId)) ?? undefined
  const dir = join(tmpdir(), 'shogo-live-chunks')
  mkdirSync(dir, { recursive: true })
  const chunkPath = join(dir, `${meetingId}-${input.seq}-${randomBytes(4).toString('hex')}.wav`)
  writeFileSync(chunkPath, input.audio)
  let result: Awaited<ReturnType<typeof transcribe>>
  try {
    result = await transcribe(chunkPath, { model: config.whisperModel, preferLocal: local, cloudAuth })
  } finally {
    removeAudioFiles(chunkPath)
  }

  const text = result.text.trim()
  const chunkDuration = Math.max(0, getWavDurationFromBuffer(input.audio))
  const segment: TranscriptSegment | null = text
    ? { start: input.start, end: input.start + chunkDuration, text }
    : null

  // Chunks can land out of order (or on different API pods): merge with an
  // optimistic check on updatedAt instead of a blind overwrite.
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await db.meeting.findUnique({
      where: { id: meetingId },
      select: { status: true, transcript: true, updatedAt: true },
    })
    if (!row || row.status !== 'recording') return { ok: false, reason: 'not_recording' }
    const raw = safeJson(row.transcript)
    const seqs: number[] = Array.isArray(raw?.liveSeqs) ? raw.liveSeqs.filter(Number.isInteger) : []
    const current = parseTranscript(row.transcript) ?? { text: '', segments: [] }
    if (seqs.includes(input.seq)) return { ok: true, segment: null, transcript: current }
    const segments = segment
      ? [...current.segments, segment].sort((a, b) => a.start - b.start)
      : current.segments
    const next = {
      text: segments.map((s) => s.text).join(' '),
      segments,
      language: result.language || current.language || 'en',
      live: true,
      liveSeqs: [...seqs, input.seq],
    }
    const updated = await db.meeting.updateMany({
      where: { id: meetingId, status: 'recording', updatedAt: row.updatedAt },
      data: { transcript: JSON.stringify(next) },
    })
    if (updated.count === 1) return { ok: true, segment, transcript: { text: next.text, segments, language: next.language } }
  }
  return { ok: false, reason: 'not_recording' }
}

function safeJson(raw: string | null | undefined): any {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function getWavDurationFromBuffer(buffer: Buffer): number {
  if (buffer.length <= WAV_HEADER_SIZE || buffer.toString('ascii', 0, 4) !== 'RIFF') return 0
  const channels = buffer.readUInt16LE(22)
  const sampleRate = buffer.readUInt32LE(24)
  const bitsPerSample = buffer.readUInt16LE(34)
  const bytesPerFrame = (bitsPerSample / 8) * channels
  if (!bytesPerFrame || !sampleRate) return 0
  return (buffer.length - WAV_HEADER_SIZE) / (sampleRate * bytesPerFrame)
}

export function removeAudioFiles(audioPath: string | null | undefined): void {
  if (!audioPath) return
  const candidates = [
    audioPath,
    audioPath.replace(/\.wav$/, '-16k.wav'),
    audioPath.replace(/\.[^.]+$/, '.json'),
  ]
  for (const path of new Set(candidates)) {
    if (path && existsSync(path)) {
      try {
        unlinkSync(path)
      } catch (err) {
        console.warn(`[Meetings] Failed to delete ${path}`, err)
      }
    }
  }
}

export function writeTranscriptToProject(projectId: string, meeting: any): void {
  const workspacesDir = process.env.WORKSPACES_DIR
  if (!workspacesDir) return
  const projectDir = join(workspacesDir, projectId)
  if (!existsSync(projectDir)) return
  const meetingsDir = join(projectDir, '.meetings')
  mkdirSync(meetingsDir, { recursive: true })
  const dateStr = meetingDate(meeting.createdAt).toISOString().split('T')[0]
  writeFileSync(
    join(meetingsDir, `${dateStr}-${meeting.id}.md`),
    meetingToMarkdown(meeting, { includeTranscript: true }),
    'utf-8',
  )
}

// ---------------------------------------------------------------------------
// Recording drafts
// ---------------------------------------------------------------------------

export const MAX_MEETING_NOTES_CHARS = 100_000

export function cleanMeetingNotes(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') return undefined
  return value.slice(0, MAX_MEETING_NOTES_CHARS)
}

/**
 * The meeting row for a desktop recording that is still in progress, created
 * on first write so notes typed in the island attach to it. Returns null when
 * the recording id belongs to another workspace.
 */
export async function upsertRecordingDraft(
  owner: { workspaceId: string; userId: string | null },
  recordingId: string,
  input: { notes?: unknown; app?: unknown; title?: unknown },
) {
  const notes = cleanMeetingNotes(input.notes)
  const app = typeof input.app === 'string' && input.app.trim() ? input.app.trim().slice(0, 80) : undefined
  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, 200) : undefined
  const existing = await db.meeting.findUnique({ where: { recordingId } })
  if (existing && existing.workspaceId !== owner.workspaceId) return null
  if (existing) {
    const data: Record<string, unknown> = {}
    if (notes !== undefined) data.notes = notes
    if (app && !existing.app) {
      data.app = app
      if (isDefaultTitle(existing.title)) data.title = defaultMeetingTitle(meetingDate(existing.createdAt), app)
    }
    if (title) data.title = title
    return db.meeting.update({ where: { id: existing.id }, data })
  }
  return db.meeting.create({
    data: {
      recordingId,
      workspaceId: owner.workspaceId,
      userId: owner.userId,
      status: 'recording',
      source: 'desktop',
      app: app ?? null,
      notes: notes ?? null,
      title: title ?? defaultMeetingTitle(new Date(), app),
    },
  })
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function toTemplateView(row: any): MeetingTemplateView {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    instructions: row.instructions,
    builtIn: false,
  }
}

export async function listMeetingTemplates(workspaceId: string): Promise<MeetingTemplateView[]> {
  const rows = await db.meetingTemplate.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
  })
  return [...BUILTIN_MEETING_TEMPLATES, ...rows.map(toTemplateView)]
}

export async function getMeetingTemplate(
  workspaceId: string,
  templateId: string | null | undefined,
): Promise<MeetingTemplateView> {
  const builtin = findBuiltinTemplate(templateId)
  if (builtin) return builtin
  if (templateId && !isBuiltinTemplateId(templateId)) {
    const row = await db.meetingTemplate.findFirst({ where: { id: templateId, workspaceId } })
    if (row) return toTemplateView(row)
  }
  return findBuiltinTemplate(DEFAULT_TEMPLATE_ID)!
}

export interface MeetingTemplateInput {
  name?: string
  description?: string | null
  instructions?: string
}

export function validateTemplateInput(
  input: MeetingTemplateInput,
  partial: boolean,
): { ok: true; data: MeetingTemplateInput } | { ok: false; error: string } {
  const data: MeetingTemplateInput = {}
  if (input.name !== undefined || !partial) {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!name) return { ok: false, error: 'Template name is required' }
    if (name.length > 80) return { ok: false, error: 'Template name must be 80 characters or fewer' }
    data.name = name
  }
  if (input.instructions !== undefined || !partial) {
    const instructions = typeof input.instructions === 'string' ? input.instructions.trim() : ''
    if (!instructions) return { ok: false, error: 'Template instructions are required' }
    if (instructions.length > 8000) return { ok: false, error: 'Template instructions must be 8000 characters or fewer' }
    data.instructions = instructions
  }
  if (input.description !== undefined) {
    const description = typeof input.description === 'string' ? input.description.trim() : ''
    data.description = description ? description.slice(0, 200) : null
  }
  return { ok: true, data }
}

// ---------------------------------------------------------------------------
// Enhancement
// ---------------------------------------------------------------------------

const TRANSCRIPT_PROMPT_CHARS = 120_000

const ENHANCE_SYSTEM_PROMPT = `You turn a meeting into clear, useful notes for the person who attended it.

You get the user's own rough notes (possibly empty) and an automatic transcript. The user's notes are the spine: keep every point they wrote, in their order of importance, and expand each with what the transcript says about it. Then add anything important from the transcript that the user didn't write down.

Rules:
- Start with a single line "# <title>": a short, specific title for the meeting (under 60 characters, no dates).
- Then follow the template's sections exactly, as markdown "##" headings.
- Use tight bullets. No filler, no preamble, no closing remarks.
- Attribute statements to speakers only when the transcript names them; otherwise say "someone" or leave it out. Never invent names.
- Only include facts supported by the notes or transcript. If the transcript is empty or garbled, work from the notes alone.
- Under "## Action items", write each as "- [ ] <task> — <owner>" (omit " — <owner>" when unknown). Write "- None" if there are none.`

function buildEnhancePrompt(meeting: any, template: MeetingTemplateView): string {
  const notes = (meeting.notes || '').trim()
  const transcript = transcriptToText(parseTranscript(meeting.transcript), TRANSCRIPT_PROMPT_CHARS)
  const when = meetingDate(meeting.createdAt).toISOString()
  return [
    `Template: ${template.name}`,
    template.instructions,
    '',
    `Meeting started: ${when}${meeting.app ? ` (${meeting.app})` : ''}`,
    '',
    '<user_notes>',
    notes || '(none)',
    '</user_notes>',
    '',
    '<transcript>',
    transcript || '(empty)',
    '</transcript>',
  ].join('\n')
}

/** Split the model's output into a title and body. */
export function splitEnhancedNotes(output: string): { title: string | null; body: string } {
  const text = output.trim().replace(/^```(?:markdown)?\n([\s\S]*?)\n```$/, '$1').trim()
  const match = text.match(/^#\s+(.+)\n?/)
  if (!match) return { title: null, body: text }
  return { title: match[1].trim().slice(0, 120) || null, body: text.slice(match[0].length).trim() }
}

/** Action items from the "## Action items" section of enhanced notes. */
export function extractActionItems(markdown: string): MeetingActionItem[] {
  const lines = markdown.split('\n')
  const items: MeetingActionItem[] = []
  let inSection = false
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      inSection = /^#{1,6}\s+action items\b/i.test(line)
      continue
    }
    if (!inSection) continue
    const match = line.match(/^\s*[-*]\s+(?:\[( |x|X)\]\s+)?(.+)$/)
    if (!match) continue
    const body = match[2].trim()
    if (!body || /^none\.?$/i.test(body)) continue
    const [text, owner] = body.split(/\s+—\s+/, 2)
    items.push({
      text: text.trim(),
      ...(owner?.trim() ? { owner: owner.trim() } : {}),
      done: match[1] === 'x' || match[1] === 'X',
    })
  }
  return items
}

export async function enhanceMeeting(
  meetingId: string,
  options: { templateId?: string | null } = {},
): Promise<void> {
  const meeting = await db.meeting.findUnique({ where: { id: meetingId } })
  if (!meeting) return
  const templateId = options.templateId ?? meeting.templateId ?? DEFAULT_TEMPLATE_ID
  const hasTranscript = !!transcriptToText(parseTranscript(meeting.transcript))
  if (!hasTranscript && !meeting.notes?.trim()) {
    await db.meeting.update({
      where: { id: meetingId },
      data: { enhanceStatus: 'skipped', enhanceError: 'Nothing to enhance yet: no notes or transcript.', templateId },
    })
    return
  }

  await db.meeting.update({
    where: { id: meetingId },
    data: { enhanceStatus: 'running', enhanceError: null, templateId },
  })

  try {
    const template = await getMeetingTemplate(meeting.workspaceId, templateId)
    const auth = await workspaceProxyAuth(meeting.workspaceId, meeting.userId)
    const resolved =
      (auth ? resolveLanguageModel(DEFAULT_ASSISTANT_MODEL, { proxy: { url: auth.proxyUrl, token: auth.proxyToken } }) : null) ??
      resolveLanguageModel(DEFAULT_ASSISTANT_MODEL)
    if (!resolved) throw new Error('No model is configured for meeting notes')

    const result = await generateText({
      model: resolved.model,
      system: ENHANCE_SYSTEM_PROMPT,
      prompt: buildEnhancePrompt(meeting, template),
      maxOutputTokens: 4000,
    })
    const { title, body } = splitEnhancedNotes(result.text)
    if (!body) throw new Error('The model returned empty notes')

    await db.meeting.update({
      where: { id: meetingId },
      data: {
        enhancedNotes: body,
        actionItems: JSON.stringify(extractActionItems(body)),
        enhanceStatus: 'ready',
        enhanceError: null,
        ...(title && isDefaultTitle(meeting.title) ? { title } : {}),
      },
    })
  } catch (err: any) {
    console.error(`[Meetings] Enhancement error for ${meetingId}:`, err?.message ?? err)
    await db.meeting
      .update({
        where: { id: meetingId },
        data: { enhanceStatus: 'error', enhanceError: friendlyMeetingError('notes', err) },
      })
      .catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Search (the companion's "chat across meetings")
// ---------------------------------------------------------------------------

export interface MeetingSearchHit {
  id: string
  title: string | null
  createdAt: Date
  duration: number | null
  snippet: string
  score: number
}

const SEARCH_FIELDS = ['title', 'enhancedNotes', 'notes', 'transcript'] as const
const FIELD_WEIGHTS: Record<(typeof SEARCH_FIELDS)[number], number> = {
  title: 5,
  enhancedNotes: 3,
  notes: 3,
  transcript: 1,
}

export function searchTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2))].slice(0, 8)
}

function snippetAround(text: string, terms: string[], radius = 140): string {
  const lower = text.toLowerCase()
  let at = -1
  for (const term of terms) {
    const i = lower.indexOf(term)
    if (i >= 0 && (at < 0 || i < at)) at = i
  }
  if (at < 0) return text.slice(0, radius * 2).trim()
  const start = Math.max(0, at - radius)
  const end = Math.min(text.length, at + radius)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let i = haystack.indexOf(needle)
  while (i >= 0 && count < 50) {
    count++
    i = haystack.indexOf(needle, i + needle.length)
  }
  return count
}

export function scoreMeeting(meeting: Record<string, any>, terms: string[]): { score: number; snippet: string } {
  let score = 0
  let bestField: string | null = null
  let bestFieldScore = 0
  for (const field of SEARCH_FIELDS) {
    const raw = field === 'transcript' ? transcriptToText(parseTranscript(meeting.transcript)) : meeting[field]
    if (!raw) continue
    const lower = String(raw).toLowerCase()
    let fieldScore = 0
    for (const term of terms) fieldScore += Math.min(countOccurrences(lower, term), 10) * FIELD_WEIGHTS[field]
    score += fieldScore
    if (fieldScore > bestFieldScore && field !== 'title') {
      bestFieldScore = fieldScore
      bestField = String(raw)
    }
  }
  const fallback = meeting.enhancedNotes || meeting.notes || ''
  return { score, snippet: snippetAround(bestField ?? fallback, terms) }
}

export async function searchMeetings(
  workspaceId: string,
  query: string,
  options: { limit?: number; since?: Date } = {},
): Promise<MeetingSearchHit[]> {
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50)
  const terms = searchTerms(query)
  const where: any = { workspaceId }
  if (options.since) where.createdAt = { gte: options.since }
  if (terms.length > 0) {
    const insensitive = isLocalMode() ? {} : { mode: 'insensitive' }
    where.OR = terms.flatMap((term) =>
      SEARCH_FIELDS.map((field) => ({ [field]: { contains: term, ...insensitive } })),
    )
  }
  const candidates = await db.meeting.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: terms.length > 0 ? 200 : limit,
    select: { id: true, title: true, createdAt: true, duration: true, notes: true, enhancedNotes: true, transcript: true },
  })
  const hits = candidates.map((m: any) => {
    const { score, snippet } = terms.length > 0 ? scoreMeeting(m, terms) : { score: 0, snippet: snippetAround(m.enhancedNotes || m.notes || '', []) }
    return { id: m.id, title: m.title, createdAt: m.createdAt, duration: m.duration, snippet, score }
  })
  if (terms.length > 0) hits.sort((a: MeetingSearchHit, b: MeetingSearchHit) => b.score - a.score || +b.createdAt - +a.createdAt)
  return hits.filter((h: MeetingSearchHit) => terms.length === 0 || h.score > 0).slice(0, limit)
}

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

export function newShareToken(): string {
  return randomBytes(18).toString('base64url')
}

/** What a share link exposes: the notes, never the transcript or audio. */
export function serializeSharedMeeting(meeting: any) {
  return {
    title: meeting.title,
    createdAt: meeting.createdAt,
    duration: meeting.duration,
    enhancedNotes: meeting.enhancedNotes,
    actionItems: parseActionItems(meeting.actionItems),
  }
}
