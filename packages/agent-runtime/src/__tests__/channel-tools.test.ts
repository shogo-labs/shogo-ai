// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, sep } from 'path'
import { createTools, type ToolContext } from '../gateway-tools'
import { downloadedPath, pruneChatFiles, safeSegment } from '../chat-files'
import { CORE_TOOL_NAMES } from '../capability-profiles'
import { CHANNEL_TOOL_NAMES, createAgentRunTools, createChannelTools, TEAM_CHAT_GUIDE, teamChatToolsAvailable } from '../channel-tools'

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

  test('a project-anchored runtime cannot see or stop other agents', () => {
    process.env.WORKSPACE_ANCHOR_PROJECT_ID = 'anchor-1'
    try {
      const anchored = createTools(ctx({}, 'team')).map((t) => t.name)
      expect(anchored).toContain('team_chat_post')
      expect(anchored).not.toContain('agent_runs_list')
      expect(anchored).not.toContain('agent_run_stop')
    } finally {
      delete process.env.WORKSPACE_ANCHOR_PROJECT_ID
    }
  })
})

describe('running agents', () => {
  const runTool = (name: string, context = ctx({ sessionId: 'sess-ws' })) => {
    const found = createAgentRunTools(context).find((t) => t.name === name)
    if (!found) throw new Error(`missing ${name}`)
    return found
  }
  const run = {
    messageId: 'm-run', agent: 'Builder', projectId: 'p-b', channel: { id: 'c1', name: 'eng', kind: 'public' },
    threadRootId: 'root-1', startedAt: '2026-10-16T20:00:00Z', preview: 'working', canStop: true,
  }

  test('agent_runs_list filters by channel and thread and leaves out its own session', async () => {
    reply = { runs: [run] }
    const result = payload(await runTool('agent_runs_list').execute('t', { channel: '#eng', thread: 'root-1' }))
    expect(result.runs).toEqual([{
      message_id: 'm-run', agent: 'Builder', channel: 'eng', thread_id: 'root-1', started_at: run.startedAt,
      state: 'running', position: null, queued_at: null, preview: 'working', can_stop: true,
    }])
    const url = new URL(calls[0].url)
    expect(url.pathname).toBe('/api/internal/workspaces/ws-1/agent-channels/running-agents')
    expect(Object.fromEntries(url.searchParams)).toEqual({ channel: 'eng', threadRootId: 'root-1', sessionId: 'sess-ws' })
  })

  test('agent_runs_list says where a queued run stands, and that a parked one holds no slot', async () => {
    reply = {
      runs: [
        { ...run, state: 'queued', position: 2, queuedAt: '2026-10-16T20:00:05Z' },
        { ...run, messageId: 'm-parked', state: 'waiting' },
      ],
    }
    const result = payload(await runTool('agent_runs_list').execute('t', { channel: 'eng' }))
    expect(result.runs.map((r: any) => [r.message_id, r.state, r.position, r.queued_at])).toEqual([
      ['m-run', 'queued', 2, '2026-10-16T20:00:05Z'],
      ['m-parked', 'waiting', null, null],
    ])
  })

  test('agent_run_stop stops one run, or a whole thread, and sends its session so it never stops itself', async () => {
    reply = { stopped: [run], skipped: [{ messageId: 'm-self', reason: 'self' }] }
    const one = payload(await runTool('agent_run_stop').execute('t', { message_id: 'm-run' }))
    expect(one).toEqual({
      ok: true,
      stopped: [{ message_id: 'm-run', agent: 'Builder', channel: 'eng', thread_id: 'root-1' }],
      skipped: [{ message_id: 'm-self', reason: 'self' }],
    })
    expect(calls[0].init?.method).toBe('POST')
    expect(new URL(calls[0].url).pathname).toBe('/api/internal/workspaces/ws-1/agent-channels/running-agents/stop')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ messageId: 'm-run', sessionId: 'sess-ws' })

    await runTool('agent_run_stop').execute('t', { channel: '#eng', thread: 'root-1' })
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ channel: 'eng', threadRootId: 'root-1', sessionId: 'sess-ws' })
  })

  test('agent_run_stop needs a target, and passes API refusals through', async () => {
    const none = payload(await runTool('agent_run_stop').execute('t', { channel: 'eng' }))
    expect(none.code).toBe('invalid_input')
    expect(calls).toHaveLength(0)

    status = 403
    reply = { error: { code: 'requester_required', message: 'A signed requester is required to see or stop agents' } }
    const refused = payload(await runTool('agent_run_stop').execute('t', { message_id: 'm-run' }))
    expect(refused).toMatchObject({ code: 'requester_required', status: 403 })
  })

  test('the guide points at the stop tools for loops and requests', () => {
    expect(TEAM_CHAT_GUIDE).toContain('agent_run_stop')
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

  test('team_chat_post passes the server’s mention_warnings through to the tool result', async () => {
    reply = {
      message: { id: 'warn-1', conversationId: 'c1', threadRootId: 'warn-1', runId: null },
      mention_warnings: ['@New Project matches 7 people or agents — use the tag from team_directory'],
    }
    const posted = payload(await tool('team_chat_post').execute('t', { channel: 'eng', text: '@New Project status?' }))
    expect(posted.id).toBe('warn-1')
    expect(posted.mention_warnings).toEqual([
      '@New Project matches 7 people or agents — use the tag from team_directory',
    ])
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

  test('member_activity with detail=messages returns the records, with the filters passed through', async () => {
    reply = {
      items: [{ id: 'msg-1', source: 'team_chat', audience: 'person', text: 'take this' }],
      hasMore: true,
      nextCursor: 'cursor-2',
    }
    const out = payload(await tool('member_activity', ctx({ userId: 'admin-1' })).execute('t', {
      user: 'sam@example.com',
      detail: 'messages',
      audience: 'person',
      since: '2026-07-01T00:00:00.000Z',
      limit: 25,
    }))
    // A page, not the summary envelope: the model gets the rows and the cursor directly.
    expect(out.items[0].id).toBe('msg-1')
    expect(out.nextCursor).toBe('cursor-2')

    const url = new URL(calls[0].url)
    expect(url.pathname).toBe('/api/internal/workspaces/ws-1/member-activity/messages')
    expect(url.searchParams.get('requestedBy')).toBe('admin-1')
    expect(url.searchParams.get('audience')).toBe('person')
    expect(url.searchParams.get('since')).toBe('2026-07-01T00:00:00.000Z')
    expect(url.searchParams.get('limit')).toBe('25')
    // Never a summary-only param on the records route.
    expect(url.searchParams.get('detail')).toBeNull()
  })

  test('member_activity with detail=board narrows the summary instead of switching route', async () => {
    reply = { activity: { user: { userId: 'u2', name: 'Sam' }, totals: { cardsMoved: 2 } } }
    const out = payload(await tool('member_activity', ctx({ userId: 'admin-1' })).execute('t', {
      user: 'sam@example.com',
      detail: 'board',
    }))
    expect(out.activity.totals.cardsMoved).toBe(2)
    const url = new URL(calls[0].url)
    expect(url.pathname).toBe('/api/internal/workspaces/ws-1/member-activity')
    expect(url.searchParams.get('detail')).toBe('board')
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
  })

  test('team_chat_add_member posts the people to the channel as this agent', async () => {
    reply = { added: ['u-2'], channel: { id: 'c-1', name: 'onboarding' } }
    const result = payload(await tool('team_chat_add_member').execute('t', { channel: '#onboarding', users: ['sam@example.com'] }))
    expect(result).toMatchObject({ ok: true, added: ['u-2'] })
    expect(new URL(calls[0].url).pathname).toBe('/api/internal/workspaces/ws-1/agent-channels/onboarding/members')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ users: ['sam@example.com'], projectId: 'proj-1' })

    const empty = payload(await tool('team_chat_add_member').execute('t', { channel: 'onboarding', users: [] }))
    expect(empty.code).toBe('invalid_input')
  })

  test('team_chat_doc_read fetches the channel doc as this agent', async () => {
    reply = { channel: { id: 'c-1', name: 'roadmap' }, doc: { title: 'Plan', content: '# Q4', version: 3 }, url: 'https://x/c/c-1?doc=1' }
    const result = payload(await tool('team_chat_doc_read').execute('t', { channel: '#roadmap' }))
    expect(result).toMatchObject({ ok: true, doc: { content: '# Q4', version: 3 }, url: 'https://x/c/c-1?doc=1' })
    const url = new URL(calls[0].url)
    expect(url.pathname).toBe('/api/internal/workspaces/ws-1/agent-channels/roadmap/doc')
    expect(url.searchParams.get('projectId')).toBe('proj-1')
  })

  test('team_chat_doc_update sends mode, section and base version; replace needs a base version', async () => {
    reply = { doc: { title: 'Plan', version: 4 }, url: 'https://x/c/c-1?doc=1' }
    const result = payload(await tool('team_chat_doc_update').execute('t', {
      channel: 'roadmap', mode: 'patch_section', section: 'Decisions', content: '- Ship Friday',
    }))
    expect(result).toEqual({ ok: true, version: 4, title: 'Plan', url: 'https://x/c/c-1?doc=1' })
    expect(calls[0].init?.method).toBe('PUT')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      projectId: 'proj-1', mode: 'patch_section', content: '- Ship Friday', section: 'Decisions',
    })

    const noBase = payload(await tool('team_chat_doc_update').execute('t', { channel: 'roadmap', mode: 'replace', content: 'x' }))
    expect(noBase.code).toBe('invalid_input')
    const noSection = payload(await tool('team_chat_doc_update').execute('t', { channel: 'roadmap', mode: 'patch_section', content: 'x' }))
    expect(noSection.code).toBe('invalid_input')
    expect(calls).toHaveLength(1)

    status = 409
    reply = { error: { code: 'doc_conflict', message: 'This doc was changed by someone else' } }
    const conflict = payload(await tool('team_chat_doc_update').execute('t', { channel: 'roadmap', mode: 'replace', content: 'x', base_version: 1 }))
    expect(conflict).toMatchObject({ code: 'doc_conflict', status: 409 })
  })

  test('channel doc tools carry the budget, archive a section and surface doc_full', async () => {
    const budget = { chars: 175_492, limit: 200_000, pct: 87.7, level: 'critical' }
    reply = {
      channel: { id: 'c-1', name: 'roadmap' },
      doc: { title: 'Plan', content: '# Q4', version: 7, budget },
      url: 'https://x/c/c-1?doc=1',
      archives: [{ id: 'a-1', heading: 'SHO-26 QA gate', chars: 7688 }],
    }
    const read = payload(await tool('team_chat_doc_read').execute('t', { channel: 'roadmap', include_archive: true }))
    expect(read).toMatchObject({ ok: true, budget, archives: [{ heading: 'SHO-26 QA gate' }] })
    const readUrl = new URL(calls[0].url)
    expect(readUrl.searchParams.get('include_archive')).toBe('1')

    reply = { channel: { id: 'c-1', name: 'roadmap' }, archive: { id: 'a-1', heading: 'SHO-26 QA gate', content: 'the story' } }
    const one = payload(await tool('team_chat_doc_read').execute('t', { channel: 'roadmap', archive_id: 'a-1' }))
    expect(one.archive).toMatchObject({ heading: 'SHO-26 QA gate', content: 'the story' })
    expect(new URL(calls[1].url).searchParams.get('archive_id')).toBe('a-1')

    reply = { doc: { title: 'Plan', version: 8, budget: { chars: 160_000, limit: 200_000, pct: 80, level: 'warn' } }, url: 'https://x/c/c-1?doc=1', archive: { id: 'a-2', heading: 'Old card', chars: 1200 } }
    const archived = payload(await tool('team_chat_doc_update').execute('t', { channel: 'roadmap', mode: 'archive_section', section: 'Old card' }))
    expect(archived).toMatchObject({ ok: true, version: 8, budget: { level: 'warn' }, archived: { heading: 'Old card', chars: 1200 } })
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({
      projectId: 'proj-1', mode: 'archive_section', section: 'Old card',
    })

    const noSection = payload(await tool('team_chat_doc_update').execute('t', { channel: 'roadmap', mode: 'archive_section' }))
    expect(noSection.code).toBe('invalid_input')

    status = 400
    reply = { error: { code: 'doc_full', message: 'too big', chars: 201_000, limit: 200_000, over_by: 1_000, next: ['archive_section'] } }
    const full = payload(await tool('team_chat_doc_update').execute('t', { channel: 'roadmap', mode: 'append', content: '## Notes\n\nmore' }))
    expect(full).toMatchObject({ code: 'doc_full', status: 400, over_by: 1_000, chars: 201_000, next: ['archive_section'] })

    status = 400
    reply = { error: { code: 'use_card_thread', message: 'card narrative', reason: 'card_heading', heading: 'SHO-123 QA gate', card: 'SHO-123' } }
    const cardLog = payload(await tool('team_chat_doc_update').execute('t', { channel: 'roadmap', mode: 'append', content: '## SHO-123 QA gate\n\nstory' }))
    expect(cardLog).toMatchObject({ code: 'use_card_thread', reason: 'card_heading', card: 'SHO-123' })
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

describe('fetch_chat_files', () => {
  let dir: string
  let downloads: number

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chat-files-'))
    downloads = 0
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const files = (context = ctx({ workspaceDir: dir })) => tool('fetch_chat_files', context)

  /** Serves file bytes for /content and JSON for everything else. */
  function serveFiles(contents: Record<string, { name: string; folder: string; body: string; status?: number }>) {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      const match = new URL(url).pathname.match(/\/files\/([^/]+)\/content$/)
      if (!match) return new Response(JSON.stringify(reply), { status, headers: { 'content-type': 'application/json' } })
      downloads++
      const file = contents[decodeURIComponent(match[1])]
      if (!file || file.status) {
        return new Response(JSON.stringify({ error: { code: 'not_found', message: 'File not found' } }), { status: file?.status ?? 404 })
      }
      await new Promise((r) => setTimeout(r, 5))
      return new Response(file.body, {
        headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(file.name), 'x-file-folder': encodeURIComponent(file.folder) },
      })
    }) as any
  }

  test('lists files with the agent identity and conversation scope', async () => {
    reply = {
      conversations: [{ id: 'c1', kind: 'public', name: 'sales', folder: 'sales', fileCount: 1, lastFileAt: '2026-10-01' }],
      files: [{ id: 'f1', name: 'q3.csv', kind: 'document', mimeType: 'text/csv', size: 9, conversationId: 'c1', messageId: 'm1', uploadedBy: 'Sam', createdAt: '2026-10-01', hasText: true, folder: 'sales' }],
      nextCursor: 'f1',
    }
    const result = payload(await files().execute('t', { conversation: '#sales', kind: 'document', limit: 5 }))
    expect(result.files[0]).toMatchObject({ file_id: 'f1', has_text: true, path: null })
    expect(result.next_cursor).toBe('f1')
    const url = new URL(calls[0].url)
    expect(url.pathname).toBe('/api/internal/workspaces/ws-1/agent-channels/files')
    expect(Object.fromEntries(url.searchParams)).toEqual({ projectId: 'proj-1', conversation: '#sales', kind: 'document', limit: '5' })
  })

  test('searches file contents and reads text by offset', async () => {
    reply = { semantic: true, results: [{ fileId: 'f1', name: 'handbook.pdf', mimeType: 'application/pdf', size: 1, conversationId: 'c1', messageId: 'm1', conversation: { name: 'general' }, match: 'semantic', snippet: 'vacation policy', charStart: 4200 }] }
    const hits = payload(await files().execute('t', { query: ' vacation ' }))
    expect(hits.results[0]).toMatchObject({ file_id: 'f1', conversation: 'general', char_start: 4200, match: 'semantic' })
    expect(new URL(calls[0].url).searchParams.get('q')).toBe('vacation')

    reply = { fileId: 'f1', name: 'handbook.pdf', mimeType: 'application/pdf', text: 'policy text', offset: 4200, totalChars: 9000, nextOffset: 4211 }
    const page = payload(await files().execute('t', { file_id: 'f1', offset: 4200, limit: 11 }))
    expect(page).toMatchObject({ text: 'policy text', offset: 4200, total_chars: 9000, next_offset: 4211 })
    const url = new URL(calls[1].url)
    expect(url.pathname).toBe('/api/internal/workspaces/ws-1/agent-channels/files/f1/text')
    expect(url.searchParams.get('offset')).toBe('4200')
  })

  test('files without text suggest downloading', async () => {
    reply = { fileId: 'f2', name: 'photo.png', mimeType: 'image/png', text: null, offset: 0, totalChars: 0, nextOffset: null }
    const result = payload(await files().execute('t', { file_id: 'f2' }))
    expect(result.text).toBeNull()
    expect(result.hint).toContain('download: true')
  })

  test('downloads into chat-files/<folder>/, reuses the copy, and shares concurrent downloads', async () => {
    serveFiles({ f1: { name: 'q3.csv', folder: 'sales', body: 'a,b\n1,2' } })
    const [a, b] = await Promise.all([
      files().execute('t', { file_id: 'f1', download: true }),
      files().execute('t', { file_id: 'f1', download: true }),
    ])
    expect(payload(a)).toMatchObject({ ok: true, path: join('chat-files', 'sales', 'q3.csv'), size: 7 })
    expect(payload(b).path).toBe(payload(a).path)
    expect(downloads).toBe(1)
    expect(readFileSync(join(dir, 'chat-files', 'sales', 'q3.csv'), 'utf-8')).toBe('a,b\n1,2')

    const again = payload(await files().execute('t', { file_id: 'f1', download: true }))
    expect(again.already_downloaded).toBe(true)
    expect(downloads).toBe(1)
    expect(downloadedPath(dir, 'f1')).toBe(join('chat-files', 'sales', 'q3.csv'))
  })

  test('two files with the same name in one conversation both keep their bytes', async () => {
    serveFiles({
      'file-aaaaaa': { name: 'notes.txt', folder: 'general', body: 'first' },
      'file-bbbbbb': { name: 'notes.txt', folder: 'general', body: 'second' },
    })
    const first = payload(await files().execute('t', { file_id: 'file-aaaaaa', download: true }))
    const second = payload(await files().execute('t', { file_id: 'file-bbbbbb', download: true }))
    expect(first.path).not.toBe(second.path)
    expect(readFileSync(join(dir, first.path), 'utf-8')).toBe('first')
    expect(readFileSync(join(dir, second.path), 'utf-8')).toBe('second')
  })

  test('names from the API cannot escape chat-files/', async () => {
    serveFiles({ evil: { name: '../../../etc/passwd', folder: '../..', body: 'x' } })
    const result = payload(await files().execute('t', { file_id: 'evil', download: true }))
    expect(result.ok).toBe(true)
    expect(result.path.startsWith(`chat-files${sep}`)).toBe(true)
    expect(resolve(dir, result.path).startsWith(resolve(dir, 'chat-files') + sep)).toBe(true)
    expect(safeSegment('..', 'files')).toBe('files')
    expect(safeSegment('a/b\\c', 'x')).toBe('a_b_c')
  })

  test('download errors are returned to the model', async () => {
    serveFiles({ gone: { name: 'x', folder: 'y', body: '', status: 404 } })
    const result = payload(await files().execute('t', { file_id: 'gone', download: true }))
    expect(result).toMatchObject({ error: 'File not found', code: 'not_found', status: 404 })
    expect(existsSync(join(dir, 'chat-files'))).toBe(false)
  })

  test('listing prunes folders for conversations the agent can no longer read', async () => {
    serveFiles({
      f1: { name: 'keep.txt', folder: 'sales', body: 'k' },
      f2: { name: 'drop.txt', folder: 'secret', body: 'd' },
    })
    await files().execute('t', { file_id: 'f1', download: true })
    await files().execute('t', { file_id: 'f2', download: true })
    reply = { conversations: [{ id: 'c1', kind: 'public', name: 'sales', folder: 'sales', fileCount: 1 }], files: [], nextCursor: null }
    await files().execute('t', {})
    expect(existsSync(join(dir, 'chat-files', 'sales', 'keep.txt'))).toBe(true)
    expect(existsSync(join(dir, 'chat-files', 'secret'))).toBe(false)
    expect(downloadedPath(dir, 'f2')).toBeNull()
    expect(pruneChatFiles(dir, ['sales'])).toEqual([])
  })

  test('a failed listing prunes nothing', async () => {
    serveFiles({ f1: { name: 'keep.txt', folder: 'sales', body: 'k' } })
    await files().execute('t', { file_id: 'f1', download: true })
    status = 500
    reply = { error: 'boom' }
    await files().execute('t', {})
    expect(existsSync(join(dir, 'chat-files', 'sales', 'keep.txt'))).toBe(true)
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

  test('teaches agents to stop a tag loop themselves', () => {
    expect(TEAM_CHAT_GUIDE).toContain('### Knowing when to stop')
    expect(TEAM_CHAT_GUIDE).toContain('A reply with no agent tag ends the exchange')
    expect(TEAM_CHAT_GUIDE).toContain('stop handing it back')
    expect(TEAM_CHAT_GUIDE).toContain('Agents do not need to tag you when they finish')
    expect(TEAM_CHAT_GUIDE).toContain('turn off any schedule of yours that checks on that work')
  })

  test('explains message kinds and the status card', () => {
    for (const kind of ['status', 'result', 'decision', 'alert']) expect(TEAM_CHAT_GUIDE).toContain(`\`${kind}\``)
    expect(TEAM_CHAT_GUIDE).toContain('team_chat_update')
    expect(TEAM_CHAT_GUIDE).toContain('Do not post a new message for each step')
  })

  test('tells agents to read the channel doc, not to write into it', () => {
    expect(TEAM_CHAT_GUIDE).not.toContain('record settled decisions')
    expect(TEAM_CHAT_GUIDE).not.toContain('long content there')
    expect(TEAM_CHAT_GUIDE).not.toContain('prefer `patch_section` or `append`')
    expect(TEAM_CHAT_GUIDE).not.toContain('then mention the change briefly')
    expect(TEAM_CHAT_GUIDE).toContain('kept by the people in it')
    expect(TEAM_CHAT_GUIDE).toContain('Do not add to it or edit it on your own initiative')
    expect(TEAM_CHAT_GUIDE).toContain('change it only when someone asks you to')
  })
})
