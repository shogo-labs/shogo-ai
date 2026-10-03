// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createTools, type ToolContext } from '../gateway-tools'
import { CORE_TOOL_NAMES } from '../capability-profiles'
import { CHANNEL_TOOL_NAMES, createChannelTools } from '../channel-tools'

function ctx(overrides: Partial<ToolContext> = {}, capabilityProfile?: 'personal' | 'team'): ToolContext {
  return {
    workspaceDir: '/tmp/channel-tools',
    channels: new Map(),
    workspaceId: 'ws-1',
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: true,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
      capabilityProfile,
    } as any,
    projectId: 'proj-1',
    ...overrides,
  }
}

const realFetch = globalThis.fetch
const saved = {
  api: process.env.SHOGO_API_URL,
  mode: process.env.WORKSPACE_RUNTIME,
  project: process.env.PROJECT_ID,
  workspace: process.env.WORKSPACE_ID,
}
let calls: Array<{ url: string; init?: RequestInit }> = []
let reply: unknown = {}
let status = 200

beforeEach(() => {
  calls = []
  reply = {}
  status = 200
  process.env.SHOGO_API_URL = 'http://api.test'
  delete process.env.WORKSPACE_RUNTIME
  delete process.env.PROJECT_ID
  delete process.env.WORKSPACE_ID
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(reply), { status, headers: { 'content-type': 'application/json' } })
  }) as any
})

afterEach(() => {
  globalThis.fetch = realFetch
  for (const [key, env] of [['api', 'SHOGO_API_URL'], ['mode', 'WORKSPACE_RUNTIME'], ['project', 'PROJECT_ID'], ['workspace', 'WORKSPACE_ID']] as const) {
    const value = saved[key]
    if (value === undefined) delete process.env[env]
    else process.env[env] = value
  }
})

function tool(name: string, context = ctx()) {
  const found = createChannelTools(context).find((t) => t.name === name)
  if (!found) throw new Error(`missing ${name}`)
  return found
}

const payload = (result: any) => JSON.parse(result.content[0].text)

describe('registration', () => {
  test('team runtimes with a workspace get channel tools; the personal companion does not', () => {
    const team = createTools(ctx({}, 'team')).map((t) => t.name)
    const personal = createTools(ctx({}, 'personal')).map((t) => t.name)
    for (const name of CHANNEL_TOOL_NAMES) {
      expect(team).toContain(name)
      expect(personal).not.toContain(name)
      expect(CORE_TOOL_NAMES as readonly string[]).toContain(name)
    }
  })
})

describe('channel tools call the internal agent-channel API', () => {
  test('team_chat_read strips # and forwards thread and limit', async () => {
    reply = { channel: { id: 'c1', name: 'general' }, messages: [{ id: 'm1', text: 'hi' }] }
    const result = payload(await tool('team_chat_read').execute('t', { channel: '#general', thread_id: 'root-1', limit: 5 }))
    expect(result.messages[0].id).toBe('m1')
    const url = new URL(calls[0].url)
    expect(url.pathname).toBe('/api/internal/workspaces/ws-1/agent-channels/general/messages')
    expect(url.searchParams.get('threadRootId')).toBe('root-1')
    expect(url.searchParams.get('limit')).toBe('5')
  })

  test('team_chat_post sends the project identity; workspace runtimes post as the workspace agent', async () => {
    reply = { message: { id: 'm2', conversationId: 'c1' } }
    const posted = payload(await tool('team_chat_post').execute('t', { channel: 'general', text: 'Done', thread_id: 'r1' }))
    expect(posted).toEqual({ ok: true, id: 'm2', conversationId: 'c1' })
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ text: 'Done', threadRootId: 'r1', projectId: 'proj-1' })

    process.env.WORKSPACE_RUNTIME = 'true'
    process.env.WORKSPACE_ID = 'ws-1'
    await tool('team_chat_post').execute('t', { channel: 'general', text: 'From the workspace agent' })
    expect(JSON.parse(String(calls[1].init?.body)).projectId).toBeNull()
  })

  test('team_chat_dm and team_chat_search', async () => {
    reply = { message: { id: 'm3', conversationId: 'dm1' } }
    await tool('team_chat_dm').execute('t', { user: 'ana@example.com', text: 'Approve?' })
    expect(new URL(calls[0].url).pathname).toBe('/api/internal/workspaces/ws-1/agent-channels/dm')
    expect(JSON.parse(String(calls[0].init?.body)).user).toBe('ana@example.com')

    reply = { results: [{ id: 'm4', channel: 'support', text: 'refund issued' }] }
    const found = payload(await tool('team_chat_search').execute('t', { query: 'refund' }))
    expect(found.results[0].channel).toBe('support')
    expect(new URL(calls[1].url).searchParams.get('q')).toBe('refund')
  })

  test('validation and API errors are returned to the model', async () => {
    const empty = payload(await tool('team_chat_post').execute('t', { channel: 'general', text: '  ' }))
    expect(empty.code).toBe('invalid_input')
    expect(calls).toHaveLength(0)

    status = 404
    reply = { error: 'Channel not found', code: 'not_found' }
    const missing = payload(await tool('team_chat_read').execute('t', { channel: 'nope' }))
    expect(missing.error).toBe('Channel not found')

    const noWs = payload(await tool('team_chat_list', ctx({ workspaceId: undefined })).execute('t', {}))
    expect(noWs.code).toBe('no_workspace')
  })
})
