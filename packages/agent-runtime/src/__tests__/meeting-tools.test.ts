// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createTools, type ToolContext } from '../gateway-tools'
import { CORE_TOOL_NAMES, PROFILE_TOOL_GROUPS } from '../capability-profiles'
import { MEETING_TOOL_NAMES, clampMeetingMarkdown, createMeetingTools } from '../meeting-tools'

function ctx(capabilityProfile?: 'personal' | 'team'): ToolContext {
  return {
    workspaceDir: '/tmp/meeting-tools',
    channels: new Map(),
    workspaceId: 'ws-personal',
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: true,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
      capabilityProfile,
    } as any,
    projectId: 'test',
  }
}

const realFetch = globalThis.fetch
let calls: Array<{ url: string; init?: RequestInit }> = []
let reply: unknown = {}
const prevApiUrl = process.env.SHOGO_API_URL

beforeEach(() => {
  calls = []
  reply = {}
  process.env.SHOGO_API_URL = 'http://api.test'
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as any
})

afterEach(() => {
  globalThis.fetch = realFetch
  if (prevApiUrl === undefined) delete process.env.SHOGO_API_URL
  else process.env.SHOGO_API_URL = prevApiUrl
})

function tool(name: string) {
  const found = createMeetingTools(ctx('personal')).find((t) => t.name === name)
  if (!found) throw new Error(`missing ${name}`)
  return found
}

function payload(result: any) {
  return JSON.parse(result.content[0].text)
}

describe('registration', () => {
  test('only the personal companion gets meeting tools', () => {
    const personal = createTools(ctx('personal')).map((t) => t.name)
    const team = createTools(ctx('team')).map((t) => t.name)
    for (const name of MEETING_TOOL_NAMES) {
      expect(personal).toContain(name)
      expect(team).not.toContain(name)
    }
  })

  test('meeting tools are classified for capability profiles', () => {
    const classified = new Set<string>(CORE_TOOL_NAMES)
    for (const names of Object.values(PROFILE_TOOL_GROUPS)) for (const n of names) classified.add(n)
    for (const name of MEETING_TOOL_NAMES) expect(classified.has(name)).toBe(true)
  })
})

describe('tools call the personal workspace meeting API', () => {
  test('meeting_search passes query and filters', async () => {
    reply = { results: [{ id: 'm1', title: 'Acme sync', snippet: 'pricing', score: 9 }] }
    const result = payload(await tool('meeting_search').execute('t', { query: 'Acme pricing', since_days: 30 }))
    expect(result.results[0].id).toBe('m1')
    const url = new URL(calls[0].url)
    expect(url.pathname).toBe('/api/internal/workspaces/ws-personal/meetings/search')
    expect(url.searchParams.get('q')).toBe('Acme pricing')
    expect(url.searchParams.get('sinceDays')).toBe('30')
  })

  test('meeting_read defaults to notes without the transcript', async () => {
    reply = { markdown: '# Acme sync' }
    const result = payload(await tool('meeting_read').execute('t', { meeting_id: 'm1' }))
    expect(result.markdown).toBe('# Acme sync')
    expect(calls[0].url).toBe('http://api.test/api/internal/workspaces/ws-personal/meetings/m1/markdown?transcript=false')
  })

  test('meeting_enhance without a meeting lists templates', async () => {
    reply = { templates: [{ id: 'builtin:general', name: 'General', builtIn: true, instructions: 'x' }] }
    const result = payload(await tool('meeting_enhance').execute('t', {}))
    expect(result.templates).toEqual([{ id: 'builtin:general', name: 'General', description: null, builtIn: true }])
  })

  test('meeting_enhance posts the template', async () => {
    reply = { ok: true, enhanceStatus: 'running' }
    await tool('meeting_enhance').execute('t', { meeting_id: 'm1', template_id: 'builtin:standup' })
    expect(calls[0].url).toEndWith('/meetings/m1/enhance')
    expect(calls[0].init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ templateId: 'builtin:standup' })
  })

  test('API errors surface to the model', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { code: 'not_personal', message: 'Meetings live in your personal workspace' } }), {
        status: 404,
      })) as any
    const result = payload(await tool('meeting_list').execute('t', {}))
    expect(result.code).toBe('not_personal')
  })
})

test('clampMeetingMarkdown keeps both ends of long meetings', () => {
  const text = `START${'x'.repeat(1000)}END`
  const clamped = clampMeetingMarkdown(text, 100)
  expect(clamped.startsWith('START')).toBe(true)
  expect(clamped.endsWith('END')).toBe(true)
  expect(clamped).toContain('truncated')
})
