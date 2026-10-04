// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { MeetingActionItem } from './meetings-api'

export interface TranscriptSegment {
  start: number
  end: number
  text: string
  speaker?: string
}

export interface ParsedTranscript {
  text: string
  segments: TranscriptSegment[]
  numSpeakers?: number
  error?: string
  /** Set on a recording's draft when live transcription has a problem. */
  liveStatus?: { state: 'ok' | 'error'; message?: string }
}

export function parseTranscript(raw: string | object | null | undefined): ParsedTranscript | null {
  if (!raw) return null
  if (typeof raw === 'object') {
    const obj = raw as any
    return {
      text: typeof obj.text === 'string' ? obj.text : '',
      segments: Array.isArray(obj.segments) ? obj.segments : [],
      numSpeakers: obj.numSpeakers,
      error: typeof obj.error === 'string' ? obj.error : undefined,
      liveStatus: obj.liveStatus?.state === 'error' ? obj.liveStatus : undefined,
    }
  }
  try {
    const parsed = JSON.parse(raw)
    return { ...parsed, segments: Array.isArray(parsed?.segments) ? parsed.segments : [] }
  } catch {
    return { text: String(raw), segments: [] }
  }
}

/** The notes view renders action items as a checklist, so drop that section from the markdown. */
export function stripActionItemsSection(markdown: string): string {
  const lines = markdown.split('\n')
  const out: string[] = []
  let skipping = false
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) skipping = /^#{1,6}\s+action items\b/i.test(line)
    if (!skipping) out.push(line)
  }
  return out.join('\n').trim()
}

export function actionItemsToMarkdown(items: MeetingActionItem[]): string {
  if (items.length === 0) return ''
  return [
    '## Action items',
    ...items.map((item) => `- [${item.done ? 'x' : ' '}] ${item.text}${item.owner ? ` — ${item.owner}` : ''}`),
  ].join('\n')
}

/** What "Copy notes" puts on the clipboard: title, enhanced notes, then the current checklist. */
export function notesForClipboard(meeting: {
  title: string | null
  enhancedNotes: string | null
  notes: string | null
  actionItems: MeetingActionItem[]
}): string {
  const body = meeting.enhancedNotes ? stripActionItemsSection(meeting.enhancedNotes) : meeting.notes?.trim() || ''
  return [`# ${meeting.title || 'Meeting notes'}`, body, actionItemsToMarkdown(meeting.actionItems)]
    .filter(Boolean)
    .join('\n\n')
}
