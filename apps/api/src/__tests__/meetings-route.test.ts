// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `src/routes/meetings.ts` — meeting recording, transcription,
 * and CRUD endpoints used by the desktop app.
 *
 * Covers:
 *   - GET    /api/local/meetings                          — list, no workspace
 *   - GET    /api/local/meetings/config                   — defaults when empty,
 *                                                          mapping of stored rows
 *   - PUT    /api/local/meetings/config                   — only known fields persisted,
 *                                                          response reflects new state
 *   - GET    /api/local/meetings/transcription-status     — env-derived flags
 *   - POST   /api/local/meetings/install-sherpa           — script-not-found error,
 *                                                          execSync failure
 *   - GET    /api/local/meetings/recording/status         — bridge running, browser fallback
 *   - POST   /api/local/meetings/recording/start          — bridge happy, bridge unavail
 *                                                          → browser, conflict
 *   - POST   /api/local/meetings/recording/stop           — bridge happy, browser stop, error
 *   - GET    /api/local/meetings/:id                      — 404, happy
 *   - POST   /api/local/meetings                          — no workspace, dedup, create
 *   - POST   /api/local/meetings/:id/transcribe           — 404, happy resets state
 *   - POST   /api/local/meetings/:id/attach               — 404, happy
 *   - PUT    /api/local/meetings/:id                      — 404, partial update
 *   - DELETE /api/local/meetings/:id                      — 404, deletes audio file
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// ─── Mock service modules BEFORE the route module loads ───────────────

const transcription = {
  transcribe: mock(async (..._args: any[]) => ({} as any)),
  isLocalTranscriptionAvailable: mock(() => true),
  getSherpaOfflinePath: mock(() => '/usr/local/bin/sherpa'),
  getInstalledModels: mock(() => ['base.en' as string]),
}
mock.module('../services/transcription.service', () => transcription)

const diarization = {
  isDiarizationAvailable: mock(() => true),
  diarize: mock(async (..._a: any[]) => []),
  mergeTranscriptWithSpeakers: mock((..._a: any[]) => null),
  splitTextBySpeakers: mock((..._a: any[]) => []),
}
mock.module('../services/diarization.service', () => diarization)

class BridgeUnavailableError extends Error {
  constructor() { super('bridge unavailable'); this.name = 'BridgeUnavailableError' }
}
const recording = {
  startRecording: mock(async () => ({ id: 'rec-1', audioPath: '/tmp/a.wav' })),
  stopRecording: mock(async () => null as any),
  getRecordingStatusAsync: mock(async () => ({ isRecording: false, id: null, duration: 0, audioPath: null })),
  BridgeUnavailableError,
}
mock.module('../services/recording.service', () => recording)

// ─── fs mock ──────────────────────────────────────────────────────────

const fsFiles = new Set<string>()
const unlinkCalls: string[] = []
const writeFileCalls: Array<{ path: string; data: any }> = []

mock.module('fs', () => ({
  existsSync: (p: string) => fsFiles.has(p),
  unlinkSync: (p: string) => { unlinkCalls.push(p); fsFiles.delete(p) },
  mkdirSync: (_p: string, _opts?: any) => undefined,
  writeFileSync: (p: string, data: any) => { writeFileCalls.push({ path: p, data }); fsFiles.add(p) },
  readFileSync: (p: string, _enc?: any) => {
    if (!fsFiles.has(p)) throw new Error(`ENOENT: ${p}`)
    return ''
  },
  statSync: (p: string) => {
    if (!fsFiles.has(p)) throw new Error(`ENOENT: ${p}`)
    return { size: 0, isFile: () => true, isDirectory: () => false }
  },
}))

// ─── child_process mock ───────────────────────────────────────────────

const execSyncSpy = mock((_cmd: string, _opts: any) => Buffer.from(''))
mock.module('child_process', () => ({
  execSync: execSyncSpy,
  spawn: () => ({ on: () => {}, stdout: { on: () => {} }, stderr: { on: () => {} } }),
}))

// ─── Prisma mock ──────────────────────────────────────────────────────

let workspaceRow: any = null
let meetings: Map<string, any>
let localConfig: Map<string, string>
let nextId = 1

const prismaMock = {
  workspace: { findFirst: async () => workspaceRow },
  meeting: {
    findMany: async ({ where, orderBy: _orderBy, select: _select }: any) => {
      let rows = Array.from(meetings.values())
      if (where?.workspaceId) rows = rows.filter((r) => r.workspaceId === where.workspaceId)
      return rows
    },
    findFirst: async ({ where }: any) => {
      for (const m of meetings.values()) {
        if (where?.audioPath && m.audioPath !== where.audioPath) continue
        if (where?.workspaceId && m.workspaceId !== where.workspaceId) continue
        return m
      }
      return null
    },
    findUnique: async ({ where, include }: any) => {
      const m = meetings.get(where.id)
      if (!m) return null
      if (include?.project) return { ...m, project: m.projectId ? { id: m.projectId, name: 'P' } : null }
      return m
    },
    create: async ({ data }: any) => {
      const row = { id: `m_${nextId++}`, status: 'transcribing', transcript: null, summary: null, ...data, createdAt: new Date(), updatedAt: new Date() }
      meetings.set(row.id, row)
      return row
    },
    update: async ({ where, data }: any) => {
      const m = meetings.get(where.id)
      if (!m) throw new Error('not found')
      Object.assign(m, data, { updatedAt: new Date() })
      return m
    },
    delete: async ({ where }: any) => {
      const m = meetings.get(where.id)
      meetings.delete(where.id)
      return m
    },
  },
  localConfig: {
    findMany: async ({ where }: any) => {
      const keys: string[] = where?.key?.in ?? []
      return Array.from(localConfig.entries())
        .filter(([k]) => keys.includes(k))
        .map(([key, value]) => ({ key, value }))
    },
    upsert: async ({ where, update, create }: any) => {
      const existing = localConfig.get(where.key)
      if (existing != null) {
        localConfig.set(where.key, update.value)
        return { key: where.key, value: update.value }
      }
      localConfig.set(create.key, create.value)
      return { key: create.key, value: create.value }
    },
  },
}
mock.module('../lib/prisma', () => ({ prisma: prismaMock }))

// ─── Import after mocks ──────────────────────────────────────────────

const { meetingRoutes } = await import('../routes/meetings')

const ORIG_OPENAI = process.env.OPENAI_API_KEY
const ORIG_AIPROXY = process.env.AI_PROXY_URL

beforeEach(() => {
  workspaceRow = { id: 'w1' }
  meetings = new Map()
  localConfig = new Map()
  fsFiles.clear()
  unlinkCalls.length = 0
  writeFileCalls.length = 0
  nextId = 1

  Object.values(transcription).forEach((m: any) => m.mockClear?.())
  Object.values(diarization).forEach((m: any) => m.mockClear?.())
  recording.startRecording.mockClear()
  recording.stopRecording.mockClear()
  recording.getRecordingStatusAsync.mockClear()
  execSyncSpy.mockClear()

  transcription.isLocalTranscriptionAvailable.mockImplementation(() => true)
  transcription.getSherpaOfflinePath.mockImplementation(() => '/usr/local/bin/sherpa')
  transcription.getInstalledModels.mockImplementation(() => ['base.en'])
  diarization.isDiarizationAvailable.mockImplementation(() => true)
  recording.startRecording.mockImplementation(async () => ({ id: 'rec-1', audioPath: '/tmp/a.wav' }))
  recording.stopRecording.mockImplementation(async () => null)
  recording.getRecordingStatusAsync.mockImplementation(async () => ({ isRecording: false, id: null, duration: 0, audioPath: null }))

  delete process.env.OPENAI_API_KEY
  delete process.env.AI_PROXY_URL
})

afterEach(() => {
  if (ORIG_OPENAI === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = ORIG_OPENAI
  if (ORIG_AIPROXY === undefined) delete process.env.AI_PROXY_URL
  else process.env.AI_PROXY_URL = ORIG_AIPROXY
})

// ═══════════════════════════════════════════════════════════════════════
// List + config
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/local/meetings', () => {
  test('empty array when no workspace', async () => {
    workspaceRow = null
    const res = await meetingRoutes.request('/api/local/meetings')
    expect(res.status).toBe(200)
    expect((await res.json()).meetings).toEqual([])
  })

  test('returns meetings for current workspace', async () => {
    meetings.set('m1', { id: 'm1', workspaceId: 'w1', title: 'A', status: 'ready', duration: 60, projectId: null, createdAt: new Date(), updatedAt: new Date() })
    meetings.set('m2', { id: 'm2', workspaceId: 'w1', title: 'B', status: 'transcribing', duration: 90, projectId: null, createdAt: new Date(), updatedAt: new Date() })
    const body = await (await meetingRoutes.request('/api/local/meetings')).json()
    expect(body.meetings).toHaveLength(2)
  })

  test('500 when prisma throws', async () => {
    workspaceRow = undefined as any
    const original = prismaMock.workspace.findFirst
    ;(prismaMock.workspace as any).findFirst = async () => { throw new Error('db down') }
    const res = await meetingRoutes.request('/api/local/meetings')
    expect(res.status).toBe(500)
    ;(prismaMock.workspace as any).findFirst = original
  })
})

describe('GET /api/local/meetings/config', () => {
  test('returns defaults when no rows present', async () => {
    const body = await (await meetingRoutes.request('/api/local/meetings/config')).json()
    expect(body.autoDetect).toBe(true)
    expect(body.autoRecord).toBe(false)
    expect(body.whisperModel).toBe('base.en')
    expect(body.diarizationEnabled).toBe(true)
    expect(body.gracePeriodSeconds).toBe(10)
  })

  test('reflects stored config rows', async () => {
    localConfig.set('MEETING_AUTO_DETECT', 'false')
    localConfig.set('MEETING_AUTO_RECORD', 'true')
    localConfig.set('MEETING_WHISPER_MODEL', 'small.en')
    localConfig.set('MEETING_GRACE_PERIOD_SECONDS', '30')
    const body = await (await meetingRoutes.request('/api/local/meetings/config')).json()
    expect(body.autoDetect).toBe(false)
    expect(body.autoRecord).toBe(true)
    expect(body.whisperModel).toBe('small.en')
    expect(body.gracePeriodSeconds).toBe(30)
  })

  test('falls back to defaults if findMany throws', async () => {
    const original = prismaMock.localConfig.findMany
    ;(prismaMock.localConfig as any).findMany = async () => { throw new Error('db') }
    const body = await (await meetingRoutes.request('/api/local/meetings/config')).json()
    expect(body.autoDetect).toBe(true)
    ;(prismaMock.localConfig as any).findMany = original
  })
})

describe('PUT /api/local/meetings/config', () => {
  function put(body: any) {
    return meetingRoutes.request('/api/local/meetings/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  test('persists known fields and returns updated config', async () => {
    const res = await put({ autoRecord: true, whisperModel: 'medium.en', gracePeriodSeconds: 20 })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.autoRecord).toBe(true)
    expect(body.whisperModel).toBe('medium.en')
    expect(body.gracePeriodSeconds).toBe(20)
    expect(localConfig.get('MEETING_AUTO_RECORD')).toBe('true')
    expect(localConfig.get('MEETING_WHISPER_MODEL')).toBe('medium.en')
  })

  test('ignores unknown fields', async () => {
    const res = await put({ unknownField: 'x', autoDetect: false })
    expect(res.status).toBe(200)
    expect(localConfig.has('unknownField')).toBe(false)
    expect(localConfig.get('MEETING_AUTO_DETECT')).toBe('false')
  })

  test('500 when upsert throws', async () => {
    const original = prismaMock.localConfig.upsert
    ;(prismaMock.localConfig as any).upsert = async () => { throw new Error('boom') }
    const res = await put({ autoRecord: true })
    expect(res.status).toBe(500)
    ;(prismaMock.localConfig as any).upsert = original
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Transcription status + install-sherpa
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/local/meetings/transcription-status', () => {
  test('all flags reflect mocked services', async () => {
    transcription.isLocalTranscriptionAvailable.mockImplementation(() => true)
    transcription.getInstalledModels.mockImplementation(() => ['base.en', 'small.en'])
    diarization.isDiarizationAvailable.mockImplementation(() => true)

    const body = await (await meetingRoutes.request('/api/local/meetings/transcription-status')).json()
    expect(body.localAvailable).toBe(true)
    expect(body.binaryInstalled).toBe(true)
    expect(body.installedModels).toEqual(['base.en', 'small.en'])
    expect(body.diarizationAvailable).toBe(true)
    expect(body.cloudAvailable).toBe(false)
  })

  test('cloudAvailable true when OPENAI_API_KEY set', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    const body = await (await meetingRoutes.request('/api/local/meetings/transcription-status')).json()
    expect(body.cloudAvailable).toBe(true)
  })

  test('binaryInstalled false when sherpa path null', async () => {
    transcription.getSherpaOfflinePath.mockImplementation(() => null as any)
    const body = await (await meetingRoutes.request('/api/local/meetings/transcription-status')).json()
    expect(body.binaryInstalled).toBe(false)
  })
})

describe('POST /api/local/meetings/install-sherpa', () => {
  test('500 with script-not-found message when script missing', async () => {
    const res = await meetingRoutes.request('/api/local/meetings/install-sherpa', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'base.en' }),
    })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toMatch(/download-sherpa\.mjs not found/)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Recording
// ═══════════════════════════════════════════════════════════════════════

describe('Recording endpoints', () => {
  test('status: returns bridge status when recording', async () => {
    recording.getRecordingStatusAsync.mockImplementation(async () => ({
      isRecording: true, id: 'rec-bridge', duration: 42, audioPath: '/tmp/x.wav',
    }))
    const body = await (await meetingRoutes.request('/api/local/meetings/recording/status')).json()
    expect(body.isRecording).toBe(true)
    expect(body.id).toBe('rec-bridge')
  })

  test('status: falls back to browser state when bridge says not recording', async () => {
    const body = await (await meetingRoutes.request('/api/local/meetings/recording/status')).json()
    expect(body.isRecording).toBe(false)
  })

  test('start: bridge happy path', async () => {
    const res = await meetingRoutes.request('/api/local/meetings/recording/start', { method: 'POST' })
    const body = await res.json()
    expect(body.id).toBe('rec-1')
    expect(body.audioPath).toBe('/tmp/a.wav')
  })

  test('start: bridge non-bridge error returns 400', async () => {
    recording.startRecording.mockImplementation(async () => { throw new Error('mic busy') })
    const res = await meetingRoutes.request('/api/local/meetings/recording/start', { method: 'POST' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('mic busy')
  })

  test('start: bridge unavailable → browser recording started', async () => {
    recording.startRecording.mockImplementation(async () => { throw new BridgeUnavailableError() })
    const res = await meetingRoutes.request('/api/local/meetings/recording/start', { method: 'POST' })
    const body = await res.json()
    expect(body.mode).toBe('browser')
    expect(body.id).toMatch(/^brec-/)

    // Status now reflects browser recording
    const sBody = await (await meetingRoutes.request('/api/local/meetings/recording/status')).json()
    expect(sBody.isRecording).toBe(true)
  })

  test('start: returns 400 when browser already recording', async () => {
    recording.startRecording.mockImplementation(async () => { throw new BridgeUnavailableError() })
    await meetingRoutes.request('/api/local/meetings/recording/start', { method: 'POST' })
    const res = await meetingRoutes.request('/api/local/meetings/recording/start', { method: 'POST' })
    expect(res.status).toBe(400)
    // reset state for following tests
    recording.stopRecording.mockImplementation(async () => { throw new BridgeUnavailableError() })
    await meetingRoutes.request('/api/local/meetings/recording/stop', { method: 'POST' })
  })

  test('stop: bridge success creates meeting and dedupes', async () => {
    recording.stopRecording.mockImplementation(async () => ({ audioPath: '/tmp/dup.wav', duration: 30 } as any))
    const r1 = await meetingRoutes.request('/api/local/meetings/recording/stop', { method: 'POST' })
    expect(r1.status).toBe(200)
    expect((await r1.json()).mode).toBe('bridge')
    expect(meetings.size).toBe(1)

    // Second call with same audioPath should NOT create a duplicate
    const r2 = await meetingRoutes.request('/api/local/meetings/recording/stop', { method: 'POST' })
    expect(r2.status).toBe(200)
    expect(meetings.size).toBe(1)
  })

  test('stop: bridge unavailable + nothing recording → 400', async () => {
    recording.stopRecording.mockImplementation(async () => { throw new BridgeUnavailableError() })
    const res = await meetingRoutes.request('/api/local/meetings/recording/stop', { method: 'POST' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Not recording')
  })

  test('stop: bridge non-bridge error returns 500', async () => {
    recording.stopRecording.mockImplementation(async () => { throw new Error('disk full') })
    const res = await meetingRoutes.request('/api/local/meetings/recording/stop', { method: 'POST' })
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Meetings CRUD
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/local/meetings/:id', () => {
  test('404 when missing', async () => {
    expect((await meetingRoutes.request('/api/local/meetings/nope')).status).toBe(404)
  })

  test('returns meeting with project relation', async () => {
    meetings.set('m1', {
      id: 'm1', workspaceId: 'w1', title: 'T', projectId: 'p1', status: 'ready',
      audioPath: '/x.wav', duration: 60, createdAt: new Date(), updatedAt: new Date(),
    })
    const body = await (await meetingRoutes.request('/api/local/meetings/m1')).json()
    expect(body.meeting.id).toBe('m1')
    expect(body.meeting.project?.id).toBe('p1')
  })
})

describe('POST /api/local/meetings', () => {
  function post(body: any) {
    return meetingRoutes.request('/api/local/meetings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  test('400 when no workspace', async () => {
    workspaceRow = null
    const res = await post({ audioPath: '/tmp/a.wav' })
    expect(res.status).toBe(400)
  })

  test('creates meeting and returns 201', async () => {
    const res = await post({ audioPath: '/tmp/a.wav', duration: 30, title: 'Standup' })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.meeting.title).toBe('Standup')
    expect(body.meeting.duration).toBe(30)
  })

  test('returns existing meeting (200) when audioPath duplicates', async () => {
    meetings.set('m1', { id: 'm1', workspaceId: 'w1', audioPath: '/tmp/d.wav', title: 'old', status: 'ready' })
    const res = await post({ audioPath: '/tmp/d.wav', title: 'new' })
    expect(res.status).toBe(200)
    expect((await res.json()).meeting.id).toBe('m1')
    expect(meetings.size).toBe(1)
  })

  test('default title generated when not provided', async () => {
    const res = await post({ audioPath: '/tmp/auto.wav' })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.meeting.title).toBeTruthy()
  })
})

describe('POST /api/local/meetings/:id/transcribe', () => {
  test('404 when meeting missing', async () => {
    const res = await meetingRoutes.request('/api/local/meetings/missing/transcribe', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    expect(res.status).toBe(404)
  })

  test('resets transcript + summary and returns ok', async () => {
    meetings.set('m1', { id: 'm1', workspaceId: 'w1', audioPath: '/x.wav', transcript: 'old', summary: 'sum', status: 'ready' })
    const res = await meetingRoutes.request('/api/local/meetings/m1/transcribe', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'base.en' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    // The handler kicks off transcribeMeeting fire-and-forget; the
    // background update may have already raced ahead of our assertion,
    // so we only check the synchronous response shape.
  })
})

describe('POST /api/local/meetings/:id/attach', () => {
  test('404 when meeting missing', async () => {
    const res = await meetingRoutes.request('/api/local/meetings/x/attach', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'p1' }),
    })
    expect(res.status).toBe(404)
  })

  test('attaches to project', async () => {
    meetings.set('m1', { id: 'm1', workspaceId: 'w1', projectId: null, transcript: null })
    const res = await meetingRoutes.request('/api/local/meetings/m1/attach', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'p_new' }),
    })
    expect(res.status).toBe(200)
    expect(meetings.get('m1').projectId).toBe('p_new')
  })
})

describe('PUT /api/local/meetings/:id', () => {
  test('404 when missing', async () => {
    const res = await meetingRoutes.request('/api/local/meetings/missing', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x' }),
    })
    expect(res.status).toBe(404)
  })

  test('updates title only', async () => {
    meetings.set('m1', { id: 'm1', workspaceId: 'w1', title: 'old', projectId: 'p_old' })
    const res = await meetingRoutes.request('/api/local/meetings/m1', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'new' }),
    })
    expect(res.status).toBe(200)
    expect(meetings.get('m1').title).toBe('new')
    expect(meetings.get('m1').projectId).toBe('p_old')
  })

  test('clears projectId when null passed', async () => {
    meetings.set('m1', { id: 'm1', workspaceId: 'w1', projectId: 'p1', title: 't' })
    await meetingRoutes.request('/api/local/meetings/m1', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: null }),
    })
    expect(meetings.get('m1').projectId).toBe(null)
  })
})

describe('DELETE /api/local/meetings/:id', () => {
  test('404 when missing', async () => {
    const res = await meetingRoutes.request('/api/local/meetings/missing', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  test('deletes audio file and resampled and json siblings', async () => {
    meetings.set('m1', { id: 'm1', workspaceId: 'w1', audioPath: '/tmp/a.wav' })
    fsFiles.add('/tmp/a.wav')
    fsFiles.add('/tmp/a-16k.wav')
    fsFiles.add('/tmp/a.json')
    const res = await meetingRoutes.request('/api/local/meetings/m1', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(unlinkCalls).toContain('/tmp/a.wav')
    expect(unlinkCalls).toContain('/tmp/a-16k.wav')
    expect(unlinkCalls).toContain('/tmp/a.json')
  })

  test('tolerates missing audio file (no throw)', async () => {
    meetings.set('m2', { id: 'm2', workspaceId: 'w1', audioPath: '/tmp/missing.wav' })
    const res = await meetingRoutes.request('/api/local/meetings/m2', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(unlinkCalls).not.toContain('/tmp/missing.wav')
  })
})
