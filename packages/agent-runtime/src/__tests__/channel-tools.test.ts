// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createTools, type ToolContext } from '../gateway-tools'
import { CORE_TOOL_NAMES } from '../capability-profiles'
import { CHANNEL_TOOL_NAMES, createChannelTools, TEAM_CHAT_GUIDE, teamChatToolsAvailable } from '../channel-tools'

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
    reply = { message: { id: 'm2', conversationId: 'c1', threadRootId: 'r1', runId: null } }
    const posted = payload(await tool('team_chat_post').execute('t', { channel: 'general', text: 'Done', thread_id: 'r1' }))
    expect(posted).toEqual({ ok: true, id: 'm2', conversationId: 'c1', runId: null, url: null, thread_id: 'r1' })
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ text: 'Done', threadRootId: 'r1', projectId: 'proj-1' })

    process.env.WORKSPACE_RUNTIME = 'true'
    process.env.WORKSPACE_ID = 'ws-1'
    await tool('team_chat_post').execute('t', { channel: 'general', text: 'From the workspace agent' })
    expect(JSON.parse(String(calls[1].init?.body)).projectId).toBeNull()

    // A project that has attachments runs in a merged root but is still that project.
    process.env.WORKSPACE_ANCHOR_PROJECT_ID = 'anchor-1'
    try {
      await tool('team_chat_post').execute('t', { channel: 'general', text: 'From the anchor project' })
      expect(JSON.parse(String(calls[2].init?.body)).projectId).toBe('anchor-1')
    } finally {
      delete process.env.WORKSPACE_ANCHOR_PROJECT_ID
    }
  })

  test('team_chat_post sends the chat session, owner flag and run id; a root post returns its own id as thread_id', async () => {
    reply = { message: { id: 'root-9', conversationId: 'c1', threadRootId: 'root-9', runId: 'run-7' } }
    const posted = payload(await tool('team_chat_post', ctx({ sessionId: 'sess-1' })).execute('t', {
      channel: '#issue-pipeline', text: 'New issue #12', owner: true, run_id: 'run-7',
    }))
    expect(posted.thread_id).toBe('root-9')
    expect(posted.runId).toBe('run-7')
    expect(new URL(calls[0].url).pathname).toBe('/api/internal/workspaces/ws-1/agent-channels/issue-pipeline/messages')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      text: 'New issue #12', projectId: 'proj-1', sessionId: 'sess-1', owner: true, runId: 'run-7',
    })
  })

  test('team_chat_post forwards kind and card; a card alone is enough', async () => {
    reply = { message: { id: 'card-1', conversationId: 'c1', threadRootId: 'card-1', runId: null } }
    const card = { title: 'Fix totals', steps: ['Triage', 'Fix'], step: 0, criteria: ['Total is right'] }
    const posted = payload(await tool('team_chat_post').execute('t', { channel: 'eng', card, kind: 'status' }))
    expect(posted.id).toBe('card-1')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ projectId: 'proj-1', kind: 'status', card, text: '' })
    await tool('team_chat_post').execute('t', { channel: 'eng', text: 'Merge the fix?', kind: 'decision', thread_id: 'card-1' })
    expect(JSON.parse(String(calls[1].init?.body)).kind).toBe('decision')
  })

  test('team_chat_update edits a message in place as this agent', async () => {
    reply = { message: { id: 'card-1', conversationId: 'c1' } }
    const card = { title: 'Fix totals', status: 'done', summary: 'Merged.' }
    const done = payload(await tool('team_chat_update').execute('t', { message_id: 'card-1', card, kind: 'result' }))
    expect(done).toEqual({ ok: true, id: 'card-1', conversationId: 'c1' })
    expect(calls[0].init?.method).toBe('PATCH')
    expect(new URL(calls[0].url).pathname).toBe('/api/internal/workspaces/ws-1/agent-channels/messages/card-1')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ projectId: 'proj-1', kind: 'result', card })

    const nothing = payload(await tool('team_chat_update').execute('t', { message_id: 'card-1' }))
    expect(nothing.code).toBe('invalid_input')
    expect(calls).toHaveLength(1)
  })

  test('team_directory returns people, agents and groups with their tags', async () => {
    reply = {
      directory: {
        people: [{ userId: 'u1', name: 'Ana', email: 'ana@example.com', tag: '<@u:u1>' }],
        agents: [{ projectId: 'p2', name: 'Planner', role: 'Writes plans', tag: '<@a:p:p2>' }],
        groups: [{ groupId: 'g1', handle: 'maintainers', name: 'Maintainers', tag: '<@g:g1>' }],
      },
    }
    const dir = payload(await tool('team_directory').execute('t', {}))
    expect(dir.agents[0].tag).toBe('<@a:p:p2>')
    expect(dir.groups[0].handle).toBe('maintainers')
    expect(new URL(calls[0].url).pathname).toBe('/api/internal/workspaces/ws-1/agent-channels/directory')
  })

  test('member_activity asks the API as the signed-in user, never as someone the model names', async () => {
    reply = { activity: { user: { userId: 'u2', name: 'Sam' }, totals: { approvalsDecided: 4 } } }
    const out = payload(await tool('member_activity', ctx({ userId: 'admin-1' })).execute('t', {
      user: 'sam@example.com',
      range: 'yesterday',
      timezone: 'America/Los_Angeles',
      requestedBy: 'someone-else', // not part of the schema; must be ignored
    }))
    expect(out.activity.totals.approvalsDecided).toBe(4)
    const url = new URL(calls[0].url)
    expect(url.pathname).toBe('/api/internal/workspaces/ws-1/member-activity')
    expect(url.searchParams.get('user')).toBe('sam@example.com')
    expect(url.searchParams.get('requestedBy')).toBe('admin-1')
    expect(url.searchParams.get('range')).toBe('yesterday')
    expect(url.searchParams.get('tz')).toBe('America/Los_Angeles')
  })

  test('member_activity fails closed without a signed-in user, and passes API refusals through', async () => {
    const none = payload(await tool('member_activity', ctx()).execute('t', { user: 'sam@example.com' }))
    expect(none.code).toBe('no_requesting_user')
    expect(calls).toHaveLength(0)

    const blank = payload(await tool('member_activity', ctx({ userId: 'u1' })).execute('t', { user: '  ' }))
    expect(blank.code).toBe('invalid_input')

    status = 403
    reply = { error: { code: 'forbidden', message: 'Only workspace owners and admins can look up what a teammate worked on' } }
    const refused = payload(await tool('member_activity', ctx({ userId: 'u1' })).execute('t', { user: 'sam@example.com' }))
    expect(refused.status).toBe(403)
    expect(refused.error).toContain('owners and admins')
  })

  test('the guide tells the agent to keep teammate activity private', () => {
    expect(TEAM_CHAT_GUIDE).toContain('member_activity')
    expect(TEAM_CHAT_GUIDE).toContain('Never post')
  })

  test('team_chat_dm and team_chat_search', async () => {
    reply = { message: { id: 'm3', conversationId: 'dm1' } }
    await tool('team_chat_dm', ctx({ sessionId: 'sess-2' })).execute('t', { user: 'ana@example.com', text: 'Approve?' })
    expect(new URL(calls[0].url).pathname).toBe('/api/internal/workspaces/ws-1/agent-channels/dm')
    expect(JSON.parse(String(calls[0].init?.body)).user).toBe('ana@example.com')
    expect(JSON.parse(String(calls[0].init?.body)).sessionId).toBe('sess-2')

    reply = { results: [{ id: 'm4', channel: 'support', text: 'refund issued' }] }
    const found = payload(await tool('team_chat_search').execute('t', { query: 'refund' }))
    expect(found.results[0].channel).toBe('support')
    expect(new URL(calls[1].url).searchParams.get('q')).toBe('refund')
  })

  test('team_chat_dm can send on behalf of the signed-in requester', async () => {
    reply = { message: { id: 'm5', conversationId: 'dm2', url: 'https://app.test/c/dm2' } }
    const delegated = payload(await tool('team_chat_dm', ctx({ userId: 'requester-1', sessionId: 'sess-3' })).execute('t', {
      user: 'sam@example.com',
      text: 'The release is delayed.',
      for_requester: true,
    }))
    expect(delegated).toEqual({ ok: true, id: 'm5', conversationId: 'dm2', url: 'https://app.test/c/dm2' })
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      user: 'sam@example.com',
      text: 'The release is delayed.',
      projectId: 'proj-1',
      sessionId: 'sess-3',
      onBehalfOfUserId: 'requester-1',
    })
  })

  test('team_chat_dm refuses on-behalf sends without a signed-in requester', async () => {
    const result = payload(await tool('team_chat_dm').execute('t', {
      user: 'sam@example.com',
      text: 'The release is delayed.',
      for_requester: true,
    }))
    expect(result.code).toBe('no_requesting_user')
    expect(calls).toHaveLength(0)
  test('team_chat_add_member posts the people to the channel as this agent', async () => {
    reply = { added: ['u-2'], channel: { id: 'c-1', name: 'onboarding' } }
    const result = payload(await tool('team_chat_add_member').execute('t', { channel: '#onboarding', users: ['sam@example.com'] }))
    expect(result).toMatchObject({ ok: true, added: ['u-2'] })
    expect(new URL(calls[0].url).pathname).toBe('/api/internal/workspaces/ws-1/agent-channels/onboarding/members')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ users: ['sam@example.com'], projectId: 'proj-1' })

    const empty = payload(await tool('team_chat_add_member').execute('t', { channel: 'onboarding', users: [] }))
    expect(empty.code).toBe('invalid_input')
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

describe('team chat prompt section', () => {
  test('is included only when the runtime registers the team chat tools', () => {
    expect(teamChatToolsAvailable('team')).toBe(false)
    process.env.WORKSPACE_ID = 'ws-1'
    expect(teamChatToolsAvailable('team')).toBe(true)
    expect(teamChatToolsAvailable(undefined)).toBe(true)
    expect(teamChatToolsAvailable('personal')).toBe(false)
  })

  test('covers hand-offs, tagging people, and thread ownership', () => {
    expect(TEAM_CHAT_GUIDE).toContain('## Team Chat')
    expect(TEAM_CHAT_GUIDE).toContain('Hand work to another agent by tagging it')
    expect(TEAM_CHAT_GUIDE).toContain('what you did, what you found or decided and why, and what you need next')
    expect(TEAM_CHAT_GUIDE).toContain('Tag people only when you need a decision')
    expect(TEAM_CHAT_GUIDE).toContain('team_chat_dm')
    expect(TEAM_CHAT_GUIDE).toContain('for_requester')
    expect(TEAM_CHAT_GUIDE).toContain('you own that thread')
  })

  test('explains message kinds and the status card', () => {
    for (const kind of ['status', 'result', 'decision', 'alert']) expect(TEAM_CHAT_GUIDE).toContain(`\`${kind}\``)
    expect(TEAM_CHAT_GUIDE).toContain('team_chat_update')
    expect(TEAM_CHAT_GUIDE).toContain('Do not post a new message for each step')
  })
})
