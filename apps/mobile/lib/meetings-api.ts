// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Client for `/api/workspaces/:workspaceId/meetings`. Meetings always live in
 * the user's personal workspace, whichever workspace is active, so callers
 * resolve that id with `usePersonalMeetingsWorkspaceId()` first.
 */
import { useEffect, useState } from 'react'
import { Platform } from 'react-native'
import { useWorkspaceCollection } from '../contexts/domain'
import { API_URL, createHttpClient } from './api'
import { authClient } from './auth-client'
import { usePlatformConfig } from './platform-config'
import { localFilePart } from './upload-part'

export type MeetingStatus = 'recording' | 'transcribing' | 'ready' | 'error'
export type EnhanceStatus = 'idle' | 'running' | 'ready' | 'error' | 'skipped'

export interface MeetingActionItem {
  text: string
  owner?: string
  done: boolean
}

export interface MeetingSummary {
  id: string
  title: string | null
  duration: number | null
  status: MeetingStatus
  enhanceStatus?: EnhanceStatus
  source?: string
  app?: string | null
  projectId: string | null
  createdAt: string
}

export interface MeetingDetail extends MeetingSummary {
  workspaceId: string
  transcript: string | null
  notes: string | null
  enhancedNotes: string | null
  enhanceError: string | null
  actionItems: MeetingActionItem[]
  templateId: string | null
  recordingId: string | null
  shareToken: string | null
  hasAudio: boolean
  updatedAt: string
  project?: { id: string; name: string } | null
}

export interface MeetingTemplate {
  id: string
  name: string
  description: string | null
  instructions: string
  builtIn: boolean
}

export interface MeetingSearchHit {
  id: string
  title: string | null
  createdAt: string
  duration: number | null
  snippet: string
  score: number
}

/**
 * The personal workspace id meetings belong to. Signed-in users have it in
 * the workspace collection; the desktop app without a cloud session asks the
 * local API, which resolves the install's own personal workspace.
 */
export function usePersonalMeetingsWorkspaceId(): string | null {
  const workspaces = useWorkspaceCollection()
  const { localMode } = usePlatformConfig()
  const fromCollection =
    ((workspaces?.all ?? []) as Array<{ id: string; kind?: string }>).find((w) => w.kind === 'personal')?.id ?? null
  const [fromLocal, setFromLocal] = useState<string | null>(null)

  useEffect(() => {
    if (fromCollection || !localMode) return
    let cancelled = false
    createHttpClient()
      .get<{ workspaceId: string | null }>('/api/local/meetings/workspace')
      .then((res) => {
        if (!cancelled) setFromLocal(res.data.workspaceId ?? null)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [fromCollection, localMode])

  return fromCollection ?? fromLocal
}

export function meetingsApi(workspaceId: string) {
  const http = createHttpClient()
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/meetings`
  return {
    async list(): Promise<MeetingSummary[]> {
      return (await http.get<{ meetings: MeetingSummary[] }>(base)).data.meetings ?? []
    },
    async search(q: string): Promise<MeetingSearchHit[]> {
      return (await http.get<{ results: MeetingSearchHit[] }>(`${base}/search?q=${encodeURIComponent(q)}&limit=30`)).data
        .results ?? []
    },
    async get(id: string): Promise<MeetingDetail> {
      return (await http.get<{ meeting: MeetingDetail }>(`${base}/${id}`)).data.meeting
    },
    async markdown(id: string, includeTranscript = false): Promise<string> {
      return (await http.get<{ markdown: string }>(`${base}/${id}/markdown?transcript=${includeTranscript}`)).data
        .markdown
    },
    async update(
      id: string,
      patch: Partial<Pick<MeetingDetail, 'title' | 'notes' | 'enhancedNotes' | 'templateId' | 'actionItems'>>,
    ): Promise<MeetingDetail> {
      return (await http.patch<{ meeting: MeetingDetail }>(`${base}/${id}`, patch)).data.meeting
    },
    async enhance(id: string, templateId?: string): Promise<void> {
      await http.post(`${base}/${id}/enhance`, { templateId })
    },
    async share(id: string): Promise<string> {
      return (await http.post<{ shareToken: string }>(`${base}/${id}/share`, {})).data.shareToken
    },
    async unshare(id: string): Promise<void> {
      await http.delete(`${base}/${id}/share`)
    },
    async remove(id: string): Promise<void> {
      await http.delete(`${base}/${id}`)
    },
    async createNote(notes: string, title?: string): Promise<MeetingDetail> {
      return (await http.post<{ meeting: MeetingDetail }>(base, { notes, title })).data.meeting
    },
    async templates(): Promise<MeetingTemplate[]> {
      return (await http.get<{ templates: MeetingTemplate[] }>(`${base}/templates`)).data.templates ?? []
    },
    async saveRecordingDraft(recordingId: string, draft: { notes?: string; app?: string; title?: string }) {
      return (await http.patch<{ meeting: MeetingDetail }>(`${base}/recordings/${encodeURIComponent(recordingId)}`, draft))
        .data.meeting
    },
    async getRecordingDraft(recordingId: string): Promise<MeetingDetail | null> {
      try {
        return (await http.get<{ meeting: MeetingDetail }>(`${base}/recordings/${encodeURIComponent(recordingId)}`)).data
          .meeting
      } catch {
        return null
      }
    },
    uploadUrl: `${base}/upload`,
  }
}

const meetingsChangedListeners = new Set<() => void>()

/** Tell open meeting lists to refetch (a recording finished, a meeting was created). */
export function notifyMeetingsChanged(): void {
  meetingsChangedListeners.forEach((listener) => listener())
}

export function onMeetingsChanged(listener: () => void): () => void {
  meetingsChangedListeners.add(listener)
  return () => {
    meetingsChangedListeners.delete(listener)
  }
}

export interface LiveChunkResponse {
  meetingId: string
  segment: TranscriptSegmentView | null
  transcript: { text: string; segments: TranscriptSegmentView[] }
}

export interface TranscriptSegmentView {
  start: number
  end: number
  text: string
  speaker?: string
}

export class LiveTranscriptionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/** A few seconds of a recording in progress, transcribed into the draft meeting. */
export async function postLiveChunk(
  workspaceId: string,
  recordingId: string,
  chunk: { wav: Blob; start: number; seq: number },
): Promise<LiveChunkResponse> {
  const form = new FormData()
  form.append('audio', chunk.wav, `live-${chunk.seq}.wav`)
  form.append('start', String(chunk.start))
  form.append('seq', String(chunk.seq))
  const res = await fetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/meetings/recordings/${encodeURIComponent(recordingId)}/live`,
    { method: 'POST', body: form, headers: liveAuthHeaders(), credentials: Platform.OS === 'web' ? 'include' : 'omit' },
  )
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new LiveTranscriptionError(body?.error?.message || `Live transcription failed (${res.status})`, res.status)
  return body
}

/** Ticket for the live-transcript audio socket. Throws `LiveTranscriptionError` (501 when streaming isn't available). */
export async function requestStreamTicket(
  workspaceId: string,
  recordingId: string,
): Promise<{ ticket: string; path: string; backend: string }> {
  const headers: Record<string, string> = {}
  const cookie = Platform.OS === 'web' ? null : nativeAuthCookie()
  if (cookie) headers.Cookie = cookie
  const res = await fetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/meetings/recordings/${encodeURIComponent(recordingId)}/stream-ticket`,
    { method: 'POST', headers, credentials: Platform.OS === 'web' ? 'include' : 'omit' },
  )
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new LiveTranscriptionError(body?.error?.message || `Live stream unavailable (${res.status})`, res.status)
  return body
}

export function liveEventsUrl(workspaceId: string, recordingId: string): string {
  return `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/meetings/recordings/${encodeURIComponent(recordingId)}/live/events`
}

/** Headers that authenticate a raw fetch on native (web sends its cookie itself). */
export function liveAuthHeaders(): Record<string, string> {
  const cookie = Platform.OS === 'web' ? null : nativeAuthCookie()
  return cookie ? { Cookie: cookie } : {}
}

export type MeetingAudio =
  | { kind: 'blob'; blob: Blob; filename: string }
  | { kind: 'uri'; uri: string; filename: string; type: string }

/**
 * Multipart upload for server-side transcription. Raw fetch: the SDK client
 * JSON-serializes bodies, and React Native needs its `{ uri, name, type }`
 * file shape.
 */
export async function uploadMeetingAudio(
  workspaceId: string,
  audio: MeetingAudio,
  fields: {
    source: 'mobile' | 'upload'
    duration?: number
    notes?: string
    title?: string
    recordingId?: string
    /** Set when the live transcript covers the whole recording (see `useRecording`). */
    liveChunks?: number
  },
): Promise<MeetingDetail> {
  const form = new FormData()
  if (audio.kind === 'blob') form.append('audio', audio.blob, audio.filename)
  else form.append('audio', localFilePart(audio.uri, audio.filename, audio.type) as any)
  form.append('source', fields.source)
  if (fields.duration) form.append('duration', String(fields.duration))
  if (fields.notes?.trim()) form.append('notes', fields.notes)
  if (fields.title?.trim()) form.append('title', fields.title)
  if (fields.recordingId) form.append('recordingId', fields.recordingId)
  if (fields.liveChunks !== undefined) form.append('liveChunks', String(fields.liveChunks))

  const headers: Record<string, string> = {}
  const cookie = Platform.OS === 'web' ? null : nativeAuthCookie()
  if (cookie) headers.Cookie = cookie
  const res = await fetch(`${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/meetings/upload`, {
    method: 'POST',
    body: form,
    headers,
    credentials: Platform.OS === 'web' ? 'include' : 'omit',
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error?.message || `Upload failed (${res.status})`)
  return body.meeting
}

function nativeAuthCookie(): string | null {
  const getCookie = (authClient as { getCookie?: () => string | null }).getCookie
  return typeof getCookie === 'function' ? getCookie() || null : null
}

/** Link recipients open in a browser; native builds point at the web app. */
export function meetingShareUrl(token: string): string {
  const path = `/m/${token}`
  if (Platform.OS === 'web' && typeof window !== 'undefined' && /^https?:/.test(window.location.origin)) {
    return `${window.location.origin}${path}`
  }
  return `${process.env.EXPO_PUBLIC_WEB_URL ?? 'https://studio.shogo.ai'}${path}`
}

export function isMeetingInFlight(meeting: Pick<MeetingSummary, 'status' | 'enhanceStatus'> | null | undefined): boolean {
  return !!meeting && (meeting.status === 'transcribing' || meeting.status === 'recording' || meeting.enhanceStatus === 'running')
}
