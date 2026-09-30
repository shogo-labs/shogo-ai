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
    } else if (row[key] !== cond) {
      return false
    }
  }
  return true
}

function findBy(store: Map<string, any>, where: any) {
  return Array.from(store.values()).find((row) => matches(row, where)) ?? null
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
      const row = { id: `m${++seq}`, createdAt: new Date(Date.now() + seq), transcript: null, ...data }
      meetings.set(row.id, row)
      return row
    },
    update: async ({ where, data }: any) => {
      const row = meetings.get(where.id)
      if (!row) throw new Error('not found')
      Object.assign(row, data)
      return row
    },
    delete: async ({ where }: any) => {
      const row = meetings.get(where.id)
      meetings.delete(where.id)
      return row
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
mock.module('../services/transcription.service', () => ({
  ...transcription,
  transcribe: async () => ({ text: '', segments: [], language: 'en', provider: 'test' }),
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

  test("cannot write into another workspace's draft", async () => {
    seed({ workspaceId: 'ws-other', recordingId: 'rec-2', status: 'recording', notes: 'theirs' })
    expect((await req('PUT', '/workspaces/ws-me/meetings/recordings/rec-2', { notes: 'mine' })).status).toBe(404)
    expect(findBy(meetings, { recordingId: 'rec-2' }).notes).toBe('theirs')
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

  test('audioExtension maps mime types and file names', () => {
    expect(audioExtension({ type: 'audio/webm;codecs=opus' })).toBe('webm')
    expect(audioExtension({ name: 'x.MP4' })).toBe('m4a')
    expect(audioExtension({ type: 'video/quicktime', name: 'x.mov' })).toBeNull()
  })
})
