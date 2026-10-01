// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Personal-workspace meeting routes: personal-only scoping, island recording
 * drafts, templates, enhancement, search and share links.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

let meetings = new Map<string, any>()
let templates = new Map<string, any>()
let generated = ''
let seq = 0

const WORKSPACE_KINDS: Record<string, string> = { 'ws-me': 'personal', 'ws-other': 'personal', 'ws-team': 'team' }

function matches(row: any, where: any): boolean {
  for (const [key, cond] of Object.entries(where ?? {})) {
    if (key === 'OR') {
      if (!(cond as any[]).some((c) => matches(row, c))) return false
    } else if (cond && typeof cond === 'object' && 'contains' in (cond as any)) {
      const value = String(row[key] ?? '').toLowerCase()
      if (!value.includes(String((cond as any).contains).toLowerCase())) return false
    } else if (cond && typeof cond === 'object' && 'gte' in (cond as any)) {
      if (!(row[key] >= (cond as any).gte)) return false
    } else if (cond && typeof cond === 'object' && 'lt' in (cond as any)) {
      if (!(row[key] < (cond as any).lt)) return false
    } else if (row[key] !== cond) {
      return false
    }
  }
  return true
}

function findBy(store: Map<string, any>, where: any) {
  const { workspaceId_recordingId: compound, ...rest } = where ?? {}
  return Array.from(store.values()).find((row) => matches(row, { ...rest, ...compound })) ?? null
}

function uniqueViolation() {
  const err: any = new Error('Unique constraint failed')
  err.code = 'P2002'
  return err
}

const prismaMock = {
  workspace: {
    findUnique: async ({ where }: any) => (WORKSPACE_KINDS[where.id] ? { kind: WORKSPACE_KINDS[where.id] } : null),
  },
  meeting: {
    findUnique: async ({ where }: any) => findBy(meetings, where),
    findMany: async ({ where, take }: any) =>
      Array.from(meetings.values())
        .filter((row) => matches(row, where))
        .sort((a, b) => +b.createdAt - +a.createdAt)
        .slice(0, take ?? 1000),
    create: async ({ data }: any) => {
      if (data.recordingId && findBy(meetings, { workspaceId: data.workspaceId, recordingId: data.recordingId })) {
        throw uniqueViolation()
      }
      const row = { id: `m${++seq}`, createdAt: new Date(Date.now() + seq), transcript: null, ...data }
      meetings.set(row.id, row)
      return row
    },
    update: async ({ where, data }: any) => {
      const row = meetings.get(where.id)
      if (!row) throw new Error('not found')
      Object.assign(row, data, { updatedAt: new Date() })
      return row
    },
    updateMany: async ({ where, data }: any) => {
      const rows = Array.from(meetings.values()).filter((row) => matches(row, where))
      for (const row of rows) Object.assign(row, data, { updatedAt: new Date() })
      return { count: rows.length }
    },
    delete: async ({ where }: any) => {
      const row = meetings.get(where.id)
      meetings.delete(where.id)
      return row
    },
    deleteMany: async ({ where }: any) => {
      const rows = Array.from(meetings.values()).filter((row) => matches(row, where))
      for (const row of rows) meetings.delete(row.id)
      return { count: rows.length }
    },
  },
  meetingTemplate: {
    findMany: async ({ where }: any) => Array.from(templates.values()).filter((t) => matches(t, where)),
    findFirst: async ({ where }: any) => findBy(templates, where),
    create: async ({ data }: any) => {
      const row = { id: `t${++seq}`, createdAt: new Date(), updatedAt: new Date(), ...data }
      templates.set(row.id, row)
      return row
    },
    update: async ({ where, data }: any) => Object.assign(templates.get(where.id), data),
    deleteMany: async ({ where }: any) => {
      const row = findBy(templates, where)
      if (row) templates.delete(row.id)
      return { count: row ? 1 : 0 }
    },
  },
}

mock.module('../lib/prisma', () => ({ prisma: prismaMock }))
mock.module('../lib/resolve-language-model', () => ({
  DEFAULT_ASSISTANT_MODEL: 'test-model',
  resolveLanguageModel: () => ({ model: { id: 'fake' } }),
}))
mock.module('../lib/ai-proxy-token', () => ({ generateProxyToken: async () => 'proxy-token' }))
mock.module('ai', () => ({ generateText: async () => ({ text: generated }) }))
const transcription = await import('../services/transcription.service')
let transcribedText = ''
let transcribeError: Error | null = null
let transcribeCalls = 0
mock.module('../services/transcription.service', () => ({
  ...transcription,
  transcribe: async () => {
    transcribeCalls++
    if (transcribeError) throw transcribeError
    return { text: transcribedText, segments: [], language: 'en', provider: 'test' }
  },
}))

const { workspaceMeetingRoutes, sharedMeetingRoutes, audioExtension } = await import('../routes/workspace-meetings')
const service = await import('../services/meeting.service')
const app = new Hono()
app.route(
  '/api',
  workspaceMeetingRoutes({
    authorize: async (c: any) => {
      const workspaceId = c.req.param('workspaceId')
      if (workspaceId === 'ws-forbidden') return c.json({ error: 'forbidden' }, 403)
      return { workspaceId, userId: 'user-1' }
    },
  }),
)
app.route('/api', sharedMeetingRoutes())

function req(method: string, path: string, body?: unknown) {
  return app.request(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function seed(row: Record<string, any>) {
  const full = { id: `seed${++seq}`, workspaceId: 'ws-me', title: 'Meeting - Tue', status: 'ready', createdAt: new Date(), ...row }
  meetings.set(full.id, full)
  return full
}

const TRANSCRIPT = JSON.stringify({
  text: 'We agreed to ship pricing v2 next week.',
  segments: [{ start: 0, end: 4, text: 'We agreed to ship pricing v2 next week.', speaker: 'A' }],
})

beforeEach(() => {
  meetings = new Map()
  templates = new Map()
  generated = ''
  transcribedText = ''
  transcribeError = null
  transcribeCalls = 0
  delete process.env.SHOGO_LOCAL_MODE
})

describe('scoping', () => {
  test('team workspaces have no meetings', async () => {
    const res = await req('GET', '/workspaces/ws-team/meetings')
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('not_personal')
  })

  test('authorize failures pass through', async () => {
    expect((await req('GET', '/workspaces/ws-forbidden/meetings')).status).toBe(403)
  })

  test('meetings from another workspace are invisible', async () => {
    const other = seed({ workspaceId: 'ws-other' })
    expect((await req('GET', `/workspaces/ws-me/meetings/${other.id}`)).status).toBe(404)
    expect((await req('PATCH', `/workspaces/ws-me/meetings/${other.id}`, { title: 'x' })).status).toBe(404)
    expect((await req('DELETE', `/workspaces/ws-me/meetings/${other.id}`)).status).toBe(404)
    const list = await (await req('GET', '/workspaces/ws-me/meetings')).json()
    expect(list.meetings).toHaveLength(0)
  })

  test('list limits are clamped to a sane range', async () => {
    for (let i = 0; i < 3; i++) seed({})
    for (const [limit, count] of [['-5', 3], ['0', 3], ['abc', 3], ['2', 2], ['2.9', 2], ['9999', 3]] as const) {
      const body = await (await req('GET', `/workspaces/ws-me/meetings?limit=${limit}`)).json()
      expect(body.meetings).toHaveLength(count)
    }
    const { clampLimit } = await import('../routes/workspace-meetings')
    expect(clampLimit('-5', 100, 200)).toBe(100)
    expect(clampLimit(undefined, 10, 50)).toBe(10)
    expect(clampLimit('9999', 10, 50)).toBe(50)
  })

  test('audioPath never leaves the server', async () => {
    const m = seed({ audioPath: '/secret/recordings/a.wav', transcript: TRANSCRIPT })
    const body = await (await req('GET', `/workspaces/ws-me/meetings/${m.id}`)).json()
    expect(body.meeting.audioPath).toBeUndefined()
    expect(body.meeting.hasAudio).toBe(false)
    expect(JSON.parse(body.meeting.transcript).segments).toHaveLength(1)
    const noTranscript = await (await req('GET', `/workspaces/ws-me/meetings/${m.id}?transcript=false`)).json()
    expect(noTranscript.meeting.transcript).toBeUndefined()
  })
})

describe('island recording drafts', () => {
  test('PUT creates a draft, then updates notes on the same row', async () => {
    const first = await (await req('PUT', '/workspaces/ws-me/meetings/recordings/rec-1', { notes: 'ask about', app: 'Zoom' })).json()
    expect(first.meeting.status).toBe('recording')
    expect(first.meeting.title).toStartWith('Zoom call - ')
    const second = await (await req('PUT', '/workspaces/ws-me/meetings/recordings/rec-1', { notes: 'ask about pricing' })).json()
    expect(second.meeting.id).toBe(first.meeting.id)
    expect(second.meeting.notes).toBe('ask about pricing')
    expect(meetings.size).toBe(1)
    const fetched = await (await req('GET', '/workspaces/ws-me/meetings/recordings/rec-1')).json()
    expect(fetched.meeting.notes).toBe('ask about pricing')
  })

  test("the same recording id in another workspace is a separate draft", async () => {
    const theirs = seed({ workspaceId: 'ws-other', recordingId: 'rec-2', status: 'recording', notes: 'theirs' })
    expect((await req('GET', '/workspaces/ws-me/meetings/recordings/rec-2')).status).toBe(404)
    const mine = await (await req('PUT', '/workspaces/ws-me/meetings/recordings/rec-2', { notes: 'mine' })).json()
    expect(mine.meeting.id).not.toBe(theirs.id)
    expect(mine.meeting.notes).toBe('mine')
    expect(meetings.get(theirs.id).notes).toBe('theirs')
  })

  test('concurrent first writes create one draft', async () => {
    const results = await Promise.all([
      service.upsertRecordingDraft({ workspaceId: 'ws-me', userId: 'user-1' }, 'rec-race', { notes: 'typed' }),
      service.upsertRecordingDraft({ workspaceId: 'ws-me', userId: 'user-1' }, 'rec-race', {}),
    ])
    expect(results[0].id).toBe(results[1].id)
    expect(Array.from(meetings.values()).filter((m) => m.recordingId === 'rec-race')).toHaveLength(1)
    expect(findBy(meetings, { recordingId: 'rec-race' }).notes).toBe('typed')
  })

  test('enhance waits until the recording is transcribed', async () => {
    const m = seed({ status: 'recording', notes: 'x' })
    expect((await req('POST', `/workspaces/ws-me/meetings/${m.id}/enhance`, {})).status).toBe(409)
  })
})

describe('enhanced notes', () => {
  test('merges notes and transcript into template sections with action items', async () => {
    generated = [
      '# Pricing v2 launch sync',
      '## Summary',
      '- Ship pricing v2 next week',
      '## Action items',
      '- [ ] Draft the launch email — Sam',
      '- [x] Book the review',
    ].join('\n')
    const m = seed({ notes: 'pricing', transcript: TRANSCRIPT })
    const res = await req('POST', `/workspaces/ws-me/meetings/${m.id}/enhance`, { wait: true, templateId: 'builtin:standup' })
    const body = await res.json()
    expect(body.meeting.enhanceStatus).toBe('ready')
    expect(body.meeting.title).toBe('Pricing v2 launch sync')
    expect(body.meeting.templateId).toBe('builtin:standup')
    expect(body.meeting.enhancedNotes).toStartWith('## Summary')
    expect(body.meeting.actionItems).toEqual([
      { text: 'Draft the launch email', owner: 'Sam', done: false },
      { text: 'Book the review', done: true },
    ])
  })

  test('keeps a title the user chose', async () => {
    generated = '# Model title\n## Summary\n- x'
    const m = seed({ title: 'Board prep', notes: 'x' })
    const body = await (await req('POST', `/workspaces/ws-me/meetings/${m.id}/enhance`, { wait: true })).json()
    expect(body.meeting.title).toBe('Board prep')
  })

  test('skips when there is nothing to enhance', async () => {
    const m = seed({ notes: '  ' })
    const body = await (await req('POST', `/workspaces/ws-me/meetings/${m.id}/enhance`, { wait: true })).json()
    expect(body.meeting.enhanceStatus).toBe('skipped')
  })

  test('records model failures on the meeting', async () => {
    generated = '   '
    const m = seed({ notes: 'x' })
    const body = await (await req('POST', `/workspaces/ws-me/meetings/${m.id}/enhance`, { wait: true })).json()
    expect(body.meeting.enhanceStatus).toBe('error')
    expect(body.meeting.enhanceError).toContain('empty')
  })

  test('notes-only meetings require notes', async () => {
    expect((await req('POST', '/workspaces/ws-me/meetings', { notes: '' })).status).toBe(400)
    const res = await req('POST', '/workspaces/ws-me/meetings', { notes: 'hallway chat with Kim' })
    expect(res.status).toBe(201)
    expect((await res.json()).meeting.source).toBe('upload')
  })

  test('PATCH sanitizes action items', async () => {
    const m = seed({})
    const body = await (
      await req('PATCH', `/workspaces/ws-me/meetings/${m.id}`, {
        actionItems: [{ text: 'Send deck', done: true }, { text: '   ' }, null, { text: 'Call', owner: 'Ana' }],
      })
    ).json()
    expect(body.meeting.actionItems).toEqual([
      { text: 'Send deck', done: true },
      { text: 'Call', owner: 'Ana', done: false },
    ])
  })
})

describe('templates', () => {
  test('lists built-ins plus workspace templates', async () => {
    await req('POST', '/workspaces/ws-me/meetings/templates', { name: 'Sales call', instructions: '## Pain points' })
    const body = await (await req('GET', '/workspaces/ws-me/meetings/templates')).json()
    const ids = body.templates.map((t: any) => t.id)
    expect(ids).toContain('builtin:general')
    expect(body.templates.find((t: any) => t.name === 'Sales call').builtIn).toBe(false)
  })

  test('validates input and protects built-ins', async () => {
    expect((await req('POST', '/workspaces/ws-me/meetings/templates', { name: '', instructions: 'x' })).status).toBe(400)
    expect((await req('PATCH', '/workspaces/ws-me/meetings/templates/builtin:general', { name: 'x' })).status).toBe(400)
    expect((await req('DELETE', '/workspaces/ws-me/meetings/templates/builtin:general')).status).toBe(400)
  })

  test("meetings can only use built-ins or the workspace's own templates", async () => {
    templates.set('t-theirs', { id: 't-theirs', workspaceId: 'ws-other', name: 'Theirs', instructions: 'x' })
    templates.set('t-mine', { id: 't-mine', workspaceId: 'ws-me', name: 'Mine', instructions: 'x' })
    const m = seed({ notes: 'x' })
    for (const templateId of ['t-theirs', 'builtin:nope', 'made-up']) {
      const patch = await req('PATCH', `/workspaces/ws-me/meetings/${m.id}`, { templateId })
      expect(patch.status).toBe(400)
      expect((await patch.json()).error.code).toBe('invalid_template')
      expect((await req('POST', '/workspaces/ws-me/meetings', { notes: 'x', templateId })).status).toBe(400)
      expect((await req('POST', `/workspaces/ws-me/meetings/${m.id}/enhance`, { templateId })).status).toBe(400)
    }
    expect(meetings.get(m.id).templateId).toBeUndefined()
    for (const templateId of ['t-mine', 'builtin:standup']) {
      const body = await (await req('PATCH', `/workspaces/ws-me/meetings/${m.id}`, { templateId })).json()
      expect(body.meeting.templateId).toBe(templateId)
    }
  })

  test("cannot edit another workspace's template", async () => {
    templates.set('tx', { id: 'tx', workspaceId: 'ws-other', name: 'Theirs', instructions: 'x' })
    expect((await req('PATCH', '/workspaces/ws-me/meetings/templates/tx', { name: 'Mine' })).status).toBe(404)
    expect((await req('DELETE', '/workspaces/ws-me/meetings/templates/tx')).status).toBe(404)
    expect(templates.get('tx').name).toBe('Theirs')
  })
})

describe('search', () => {
  test('ranks title matches above transcript mentions and returns snippets', async () => {
    seed({ id: 'a', title: 'Weekly sync', transcript: JSON.stringify({ text: 'we briefly touched on pricing', segments: [] }) })
    seed({ id: 'b', title: 'Pricing review', enhancedNotes: '## Summary\n- New pricing tiers approved' })
    seed({ id: 'c', title: 'Hiring', notes: 'nothing relevant' })
    seed({ id: 'd', workspaceId: 'ws-other', title: 'Pricing (theirs)' })
    const body = await (await req('GET', '/workspaces/ws-me/meetings/search?q=pricing')).json()
    expect(body.results.map((r: any) => r.id)).toEqual(['b', 'a'])
    expect(body.results[0].snippet.toLowerCase()).toContain('pricing')
  })
})

describe('share links', () => {
  test('share exposes notes only, and revoking kills the link', async () => {
    const m = seed({ enhancedNotes: '## Summary\n- ok', notes: 'private scribbles', transcript: TRANSCRIPT, actionItems: '[]' })
    const { shareToken } = await (await req('POST', `/workspaces/ws-me/meetings/${m.id}/share`)).json()
    expect(shareToken.length).toBeGreaterThanOrEqual(16)
    const again = await (await req('POST', `/workspaces/ws-me/meetings/${m.id}/share`)).json()
    expect(again.shareToken).toBe(shareToken)

    const shared = await (await req('GET', `/shared-meetings/${shareToken}`)).json()
    expect(shared.meeting.enhancedNotes).toContain('Summary')
    expect(shared.meeting.notes).toBeUndefined()
    expect(shared.meeting.transcript).toBeUndefined()
    expect(shared.meeting.id).toBeUndefined()

    await req('DELETE', `/workspaces/ws-me/meetings/${m.id}/share`)
    expect((await req('GET', `/shared-meetings/${shareToken}`)).status).toBe(404)
  })

  test('share needs enhanced notes and Shogo Cloud', async () => {
    const m = seed({ notes: 'x' })
    expect((await req('POST', `/workspaces/ws-me/meetings/${m.id}/share`)).status).toBe(409)
    process.env.SHOGO_LOCAL_MODE = 'true'
    expect((await req('POST', `/workspaces/ws-me/meetings/${m.id}/share`)).status).toBe(400)
  })
})

function wav(seconds: number, sampleRate = 16000): Uint8Array {
  const dataBytes = Math.round(seconds * sampleRate) * 2
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVEfmt ', 8, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataBytes, 40)
  return new Uint8Array(buf)
}

function liveChunk(recordingId: string, start: number, seq: number, seconds = 2) {
  const form = new FormData()
  form.append('audio', new File([wav(seconds)], 'chunk.wav', { type: 'audio/wav' }))
  form.append('start', String(start))
  form.append('seq', String(seq))
  return app.request(`/api/workspaces/ws-me/meetings/recordings/${recordingId}/live`, { method: 'POST', body: form })
}

describe('live transcription', () => {
  test('chunks append in time order onto the recording draft', async () => {
    transcribedText = 'and then pricing'
    const later = await (await liveChunk('rec-live', 8, 1)).json()
    expect(later.segment).toEqual({ start: 8, end: 10, text: 'and then pricing' })
    transcribedText = 'We started with'
    const body = await (await liveChunk('rec-live', 0, 0)).json()
    expect(body.transcript.segments.map((s: any) => s.start)).toEqual([0, 8])
    expect(body.transcript.text).toBe('We started with and then pricing')
    const row = findBy(meetings, { recordingId: 'rec-live' })
    expect(row.status).toBe('recording')
    expect(JSON.parse(row.transcript).liveSeqs).toEqual([1, 0])
  })

  test('a retried chunk is not appended twice', async () => {
    transcribedText = 'hello'
    await liveChunk('rec-retry', 0, 0)
    const again = await (await liveChunk('rec-retry', 0, 0)).json()
    expect(again.segment).toBeNull()
    expect(again.transcript.segments).toHaveLength(1)
  })

  test('silence adds nothing, and finished recordings reject late chunks', async () => {
    const silent = await (await liveChunk('rec-done', 0, 0)).json()
    expect(silent.segment).toBeNull()
    findBy(meetings, { recordingId: 'rec-done' }).status = 'transcribing'
    expect((await liveChunk('rec-done', 4, 1)).status).toBe(409)
  })

  test('rejects malformed chunks and explains missing transcription', async () => {
    const form = new FormData()
    form.append('audio', new File([new Uint8Array(10)], 'x.wav', { type: 'audio/wav' }))
    form.append('start', '0')
    form.append('seq', '0')
    expect(
      (await app.request('/api/workspaces/ws-me/meetings/recordings/rec-bad/live', { method: 'POST', body: form })).status,
    ).toBe(400)
    transcribeError = new Error('No OpenAI API key or proxy configured for cloud transcription')
    const res = await liveChunk('rec-bad', 0, 1)
    expect(res.status).toBe(503)
    expect((await res.json()).error.message).toContain('Settings')
  })

  test('a failed final pass keeps the live transcript and still writes notes', async () => {
    generated = '## Summary\n- From the live transcript'
    const m = seed({ status: 'transcribing', transcript: TRANSCRIPT })
    transcribeError = new Error('OpenAI Whisper API error: 500 upstream')
    const audioPath = `${require('os').tmpdir()}/shogo-live-test-${Date.now()}.wav`
    require('fs').writeFileSync(audioPath, Buffer.from(wav(1)))
    await service.transcribeMeeting(m.id, audioPath)
    await new Promise((r) => setTimeout(r, 10))
    const row = meetings.get(m.id)
    expect(row.status).toBe('ready')
    const transcript = JSON.parse(row.transcript)
    expect(transcript.segments).toHaveLength(1)
    expect(transcript.error).toBe('Something went wrong transcribing this recording. Try again.')
    expect(row.enhancedNotes).toContain('live transcript')
    require('fs').unlinkSync(audioPath)
  })

  function finishUpload(recordingId: string, liveChunks?: number) {
    const form = new FormData()
    form.append('audio', new File([wav(16)], 'meeting.wav', { type: 'audio/wav' }))
    form.append('duration', '16')
    form.append('recordingId', recordingId)
    if (liveChunks !== undefined) form.append('liveChunks', String(liveChunks))
    return app.request('/api/workspaces/ws-me/meetings/upload', { method: 'POST', body: form })
  }

  test('a complete live transcript is kept instead of a second cloud pass', async () => {
    transcribedText = 'first part'
    await liveChunk('rec-full', 0, 0)
    transcribedText = 'second part'
    await liveChunk('rec-full', 8, 1)
    transcribedText = 'FULL PASS'
    const res = await finishUpload('rec-full', 2)
    expect(res.status).toBe(201)
    await new Promise((r) => setTimeout(r, 20))
    const row = findBy(meetings, { recordingId: 'rec-full' })
    expect(transcribeCalls).toBe(2)
    expect(row.status).toBe('ready')
    expect(row.audioPath).toBe('')
    const transcript = JSON.parse(row.transcript)
    expect(transcript.text).toBe('first part second part')
    expect(transcript.live).toBeUndefined()
  })

  test('a live transcript with gaps still gets the full pass', async () => {
    transcribedText = 'first part'
    await liveChunk('rec-gap', 0, 0)
    transcribedText = 'FULL PASS'
    await finishUpload('rec-gap', 2)
    await new Promise((r) => setTimeout(r, 20))
    expect(transcribeCalls).toBe(2)
    expect(JSON.parse(findBy(meetings, { recordingId: 'rec-gap' }).transcript).text).toBe('FULL PASS')

    transcribedText = 'only part'
    await liveChunk('rec-unsure', 0, 0)
    transcribedText = 'FULL PASS'
    await finishUpload('rec-unsure')
    await new Promise((r) => setTimeout(r, 20))
    expect(JSON.parse(findBy(meetings, { recordingId: 'rec-unsure' }).transcript).text).toBe('FULL PASS')
  })
})

describe('abandoned recording drafts', () => {
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000)

  test('stale drafts close: transcript or notes kept, empty ones deleted, live ones untouched', async () => {
    const withTranscript = seed({ recordingId: 'r1', status: 'recording', transcript: TRANSCRIPT, updatedAt: minutesAgo(11) })
    const withNotes = seed({ recordingId: 'r2', status: 'recording', notes: 'call legal', updatedAt: minutesAgo(30) })
    const empty = seed({ recordingId: 'r3', status: 'recording', updatedAt: minutesAgo(11) })
    const active = seed({ recordingId: 'r4', status: 'recording', updatedAt: minutesAgo(2) })

    expect(await service.sweepStaleRecordingDrafts()).toBe(3)
    expect(meetings.get(withTranscript.id).status).toBe('ready')
    const transcript = JSON.parse(meetings.get(withTranscript.id).transcript)
    expect(transcript.segments).toHaveLength(1)
    expect(transcript.error).toContain('ended unexpectedly')
    expect(meetings.get(withTranscript.id).duration).toBe(4)
    expect(meetings.get(withNotes.id).status).toBe('ready')
    expect(meetings.has(empty.id)).toBe(false)
    expect(meetings.get(active.id).status).toBe('recording')
  })

  test('saving the draft is a heartbeat', async () => {
    const draft = seed({ recordingId: 'r-beat', status: 'recording', updatedAt: minutesAgo(11) })
    expect((await req('PATCH', '/workspaces/ws-me/meetings/recordings/r-beat', {})).status).toBe(200)
    expect(await service.sweepStaleRecordingDrafts()).toBe(0)
    expect(meetings.get(draft.id).status).toBe('recording')
  })

  test('a recorder that comes back after the sweep still finishes its meeting', async () => {
    const draft = seed({ recordingId: 'r-late', status: 'recording', transcript: TRANSCRIPT, updatedAt: minutesAgo(11) })
    await service.sweepStaleRecordingDrafts()
    transcribedText = 'the whole meeting'
    const form = new FormData()
    form.append('audio', new File([wav(4)], 'meeting.wav', { type: 'audio/wav' }))
    form.append('recordingId', 'r-late')
    const res = await app.request('/api/workspaces/ws-me/meetings/upload', { method: 'POST', body: form })
    expect((await res.json()).meeting.id).toBe(draft.id)
    await new Promise((r) => setTimeout(r, 20))
    expect(JSON.parse(meetings.get(draft.id).transcript).text).toBe('the whole meeting')
  })
})

describe('interrupted transcription and notes', () => {
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000)

  test('stale runs fail so the user can retry; fresh runs are untouched', async () => {
    generated = '## Summary\n- From the live transcript'
    const stuckWithLive = seed({ status: 'transcribing', transcript: TRANSCRIPT, updatedAt: minutesAgo(31) })
    const stuckEmpty = seed({ status: 'transcribing', updatedAt: minutesAgo(45) })
    const transcribing = seed({ status: 'transcribing', updatedAt: minutesAgo(5) })
    const stuckNotes = seed({ enhanceStatus: 'running', updatedAt: minutesAgo(11) })
    const writingNotes = seed({ enhanceStatus: 'running', updatedAt: minutesAgo(2) })

    expect(await service.sweepStuckMeetings()).toBe(3)
    await new Promise((r) => setTimeout(r, 10))

    expect(meetings.get(stuckWithLive.id).status).toBe('ready')
    const kept = JSON.parse(meetings.get(stuckWithLive.id).transcript)
    expect(kept.segments).toHaveLength(1)
    expect(kept.error).toContain('interrupted')
    expect(meetings.get(stuckWithLive.id).enhancedNotes).toContain('live transcript')

    expect(meetings.get(stuckEmpty.id).status).toBe('error')
    expect(JSON.parse(meetings.get(stuckEmpty.id).transcript).error).toContain('interrupted')
    expect(meetings.get(transcribing.id).status).toBe('transcribing')

    expect(meetings.get(stuckNotes.id).enhanceStatus).toBe('error')
    expect(meetings.get(stuckNotes.id).enhanceError).toContain('interrupted')
    expect(meetings.get(writingNotes.id).enhanceStatus).toBe('running')
  })
})

describe('friendly errors', () => {
  test('hide provider details behind actionable sentences', () => {
    expect(service.friendlyMeetingError('notes', new Error("Model 'hoshi-2-0' is not supported. Use GET /ai/v1/models"))).toBe(
      "The AI model for notes isn't available on this machine. Sign in to Shogo Cloud or pick another model in Settings.",
    )
    expect(service.friendlyMeetingError('notes', new Error('429 Too Many Requests'))).toContain('usage limit')
    expect(service.friendlyMeetingError('transcript', new Error('fetch failed'))).toContain('connection')
    expect(service.friendlyMeetingError('notes', new Error('boom'))).toBe('Something went wrong writing notes. Try again.')
  })
})

describe('meeting.service helpers', () => {
  test('transcriptToText keeps the opening and the ending when truncating', () => {
    const segments = Array.from({ length: 200 }, (_, i) => ({ start: i * 5, end: i * 5 + 5, text: `line ${i}`, speaker: 'A' }))
    const text = service.transcriptToText({ text: '', segments }, 400)
    expect(text).toContain('line 0')
    expect(text).toContain('line 199')
    expect(text).toContain('transcript truncated')
  })

  test('splitEnhancedNotes strips a fenced block and pulls the title', () => {
    expect(service.splitEnhancedNotes('```markdown\n# Title\n## A\n- x\n```')).toEqual({ title: 'Title', body: '## A\n- x' })
    expect(service.splitEnhancedNotes('## A\n- x').title).toBeNull()
  })

  test('extractActionItems only reads the Action items section and ignores "None"', () => {
    const md = '## Decisions\n- Ship it\n## Action items\n- None.\n- Write docs — Lee\n## Notes\n- later'
    expect(service.extractActionItems(md)).toEqual([{ text: 'Write docs', owner: 'Lee', done: false }])
  })

  test('searchTerms dedupes, lowercases and drops one-letter noise', () => {
    expect(service.searchTerms('Pricing, pricing & a Q3 plan')).toEqual(['pricing', 'q3', 'plan'])
  })
})

describe('upload', () => {
  test('rejects missing and unsupported audio', async () => {
    const empty = new FormData()
    expect((await app.request('/api/workspaces/ws-me/meetings/upload', { method: 'POST', body: empty })).status).toBe(400)
    const bad = new FormData()
    bad.append('audio', new File([new Uint8Array([1, 2])], 'notes.txt', { type: 'text/plain' }))
    expect((await app.request('/api/workspaces/ws-me/meetings/upload', { method: 'POST', body: bad })).status).toBe(415)
  })

  test('mobile uploads create a transcribing meeting with typed notes', async () => {
    const form = new FormData()
    form.append('audio', new File([new Uint8Array(64)], 'rec.m4a', { type: 'audio/mp4' }))
    form.append('source', 'mobile')
    form.append('duration', '42')
    form.append('notes', 'follow up with legal')
    const res = await app.request('/api/workspaces/ws-me/meetings/upload', { method: 'POST', body: form })
    expect(res.status).toBe(201)
    const { meeting } = await res.json()
    expect(meeting.source).toBe('mobile')
    expect(meeting.duration).toBe(42)
    expect(meeting.notes).toBe('follow up with legal')
    expect(meetings.get(meeting.id).audioPath).toEndWith('.m4a')
  })

  test('an upload finishes the live draft for the same recording', async () => {
    const draft = seed({ recordingId: 'wrec-1', status: 'recording', notes: 'typed live', transcript: TRANSCRIPT })
    const form = new FormData()
    form.append('audio', new File([new Uint8Array(64)], 'rec.webm', { type: 'audio/webm' }))
    form.append('recordingId', 'wrec-1')
    const res = await app.request('/api/workspaces/ws-me/meetings/upload', { method: 'POST', body: form })
    const { meeting } = await res.json()
    expect(meeting.id).toBe(draft.id)
    expect(meeting.notes).toBe('typed live')
    expect(meetings.size).toBe(1)
  })

  test('audioExtension maps mime types and file names', () => {
    expect(audioExtension({ type: 'audio/webm;codecs=opus' })).toBe('webm')
    expect(audioExtension({ name: 'x.MP4' })).toBe('m4a')
    expect(audioExtension({ type: 'video/quicktime', name: 'x.mov' })).toBeNull()
  })
})
