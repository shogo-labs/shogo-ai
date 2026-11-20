// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { ToolContext } from '../gateway-tools'
import { createMailTools, MAIL_TOOL_NAMES } from '../mail-tools'

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceDir: '/tmp/mail-tools',
    channels: new Map(),
    workspaceId: 'ws-1',
    sessionId: 'sess-1',
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: true,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    } as any,
    projectId: 'proj-1',
    ...overrides,
  }
}

const realFetch = globalThis.fetch
const saved = { api: process.env.SHOGO_API_URL, mode: process.env.WORKSPACE_RUNTIME, project: process.env.PROJECT_ID, workspace: process.env.WORKSPACE_ID }
let calls: Array<{ url: string; method: string; body: any }> = []
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
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined })
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
  const found = createMailTools(context).find((t) => t.name === name)
  if (!found) throw new Error(`missing ${name}`)
  return found
}

async function run(name: string, params: Record<string, unknown>, context = ctx()) {
  const result: any = await tool(name, context).execute('call-1', params as any)
  return JSON.parse(result.content[0].text)
}

describe('mail tools', () => {
  test('the four tools are exactly the advertised names', () => {
    expect(createMailTools(ctx()).map((t) => t.name).sort()).toEqual([...MAIL_TOOL_NAMES].sort())
  })

  test('mail_list with no mailbox lists the mailboxes; with one, its threads', async () => {
    reply = { mailboxes: [{ address: 'support@acme.test' }] }
    const boxes = await run('mail_list', {})
    expect(boxes.ok).toBe(true)
    expect(boxes.mailboxes[0].address).toBe('support@acme.test')
    expect(calls[0]!.method).toBe('GET')
    expect(calls[0]!.url).toContain('/api/internal/workspaces/ws-1/agent-mail/mailboxes')

    reply = { threads: [] }
    await run('mail_list', { mailbox: 'support', view: 'screener', q: 'invoice' })
    const url = new URL(calls[1]!.url)
    expect(url.pathname).toBe('/api/internal/workspaces/ws-1/agent-mail/threads')
    expect(url.searchParams.get('mailbox')).toBe('support')
    expect(url.searchParams.get('view')).toBe('screener')
    expect(url.searchParams.get('q')).toBe('invoice')
  })

  test('mail_read fetches one thread by id', async () => {
    reply = { thread: { id: 't 1' }, messages: [] }
    await run('mail_read', { thread_id: 't 1' })
    expect(calls[0]!.url).toContain('/agent-mail/threads/t%201')
  })

  test('mail_reply and mail_compose post drafts, never a send', async () => {
    reply = { mail: { status: 'pending_approval' }, note: 'Drafted.' }
    const drafted = await run('mail_reply', { thread_id: 'th1', text: 'Thanks!', reply_all: true, cc: 'ops@acme.test' })
    expect(drafted.mail.status).toBe('pending_approval')
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url).toContain('/agent-mail/threads/th1/reply')
    expect(calls[0]!.body).toMatchObject({ text: 'Thanks!', reply_all: true, cc: 'ops@acme.test' })

    await run('mail_compose', { mailbox: 'support', to: ['jane@acme.test'], subject: 'Hello', text: 'Hi Jane' })
    expect(calls[1]!.url).toContain('/agent-mail/compose')
    expect(calls[1]!.body).toMatchObject({ mailbox: 'support', to: ['jane@acme.test'], subject: 'Hello', text: 'Hi Jane' })
  })

  test('an API refusal comes back as the error and its code, not a success', async () => {
    status = 402
    reply = { error: { code: 'paid_plan_required', message: 'Sending email needs a paid plan.' } }
    const out = await run('mail_compose', { mailbox: 'support', to: 'jane@acme.test', subject: 'x', text: 'y' })
    expect(out.ok).toBeUndefined()
    expect(String(out.error)).toContain('paid plan')
  })

  test('no workspace context is a clear error, with no request made', async () => {
    const out = await run('mail_list', {}, ctx({ workspaceId: undefined as any }))
    expect(out.code).toBe('no_workspace')
    expect(calls).toHaveLength(0)
  })
})
