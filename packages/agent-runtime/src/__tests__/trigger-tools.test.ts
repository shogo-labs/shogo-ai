// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, test } from 'bun:test'

const calls: Array<{ name: string; args: any[] }> = []
let createResult: any = { ok: true, status: 201, data: { trigger: { id: 'trigger-1' } } }

mock.module('../gateway-tools', () => ({
  textResult: (details: unknown) => ({ details }),
}))

mock.module('../internal-api', () => ({
  listTriggerTypes: async (...args: any[]) => {
    calls.push({ name: 'listTriggerTypes', args })
    return {
      ok: true,
      status: 200,
      data: {
        native: [{ type: 'member.joined', description: 'Someone joined', payload: {}, example: {} }],
        composio: {
          available: true,
          connectedToolkits: ['github'],
          types: [{ type: 'composio.github.GITHUB_STAR_ADDED_EVENT', name: 'Star added', description: 'x', config: {} }],
        },
      },
    }
  },
  createTrigger: async (...args: any[]) => {
    calls.push({ name: 'createTrigger', args })
    return createResult
  },
  listTriggers: async (...args: any[]) => {
    calls.push({ name: 'listTriggers', args })
    return { ok: true, status: 200, data: [{ id: 'trigger-1' }] }
  },
  listTriggerDeliveries: async (...args: any[]) => {
    calls.push({ name: 'listTriggerDeliveries', args })
    return { ok: true, status: 200, data: [{ id: 'delivery-1', status: 'ok' }] }
  },
  updateTrigger: async (...args: any[]) => {
    calls.push({ name: 'updateTrigger', args })
    return { ok: true, status: 200, data: { trigger: { id: 'trigger-1', enabled: false } } }
  },
  deleteTrigger: async (...args: any[]) => {
    calls.push({ name: 'deleteTrigger', args })
    return { ok: true, status: 200, data: { ok: true } }
  },
  testTrigger: async (...args: any[]) => {
    calls.push({ name: 'testTrigger', args })
    return { ok: true, status: 202, data: { eventId: 'event-1', type: 'member.joined', delivery: { id: 'd-1', status: 'pending' } } }
  },
}))

const tools = await import('../trigger-tools')

const ctx: any = { workspaceId: 'workspace-1', userId: 'user-1', workspaceDir: '/tmp' }

async function execute(tool: any, params: Record<string, unknown>) {
  return (await tool.execute('call-1', params)).details
}

describe('trigger tools', () => {
  beforeEach(() => {
    calls.length = 0
    createResult = { ok: true, status: 201, data: { trigger: { id: 'trigger-1' } } }
  })

  test('trigger_create maps snake_case params and runs as the signed-in user', async () => {
    const result = await execute(tools.createTriggerCreateTool(ctx), {
      name: 'Welcome new members',
      event_type: 'member.joined',
      prompt: 'DM them a welcome',
      filter: { 'member.role': 'member' },
      notify_channel: 'general',
    })
    expect(result.ok).toBe(true)
    expect(calls[0]).toEqual({
      name: 'createTrigger',
      args: ['workspace-1', expect.objectContaining({
        userId: 'user-1',
        name: 'Welcome new members',
        eventType: 'member.joined',
        prompt: 'DM them a welcome',
        filter: { 'member.role': 'member' },
        notifyConversationId: 'general',
      })],
    })
  })

  test('needs_connection tells the agent to connect the app first', async () => {
    createResult = { ok: false, status: 409, code: 'needs_connection', error: 'Connect github before creating this trigger' }
    const result = await execute(tools.createTriggerCreateTool(ctx), {
      name: 'Stars', event_type: 'composio.github.GITHUB_STAR_ADDED_EVENT', prompt: 'Thank them',
    })
    expect(result.code).toBe('needs_connection')
    expect(result.hint).toContain('connect')
  })

  test('a webhook secret is surfaced once with a note', async () => {
    createResult = { ok: true, status: 201, data: { trigger: { id: 't' }, webhookSecret: 'whsec_abc' } }
    const result = await execute(tools.createTriggerCreateTool(ctx), {
      name: 'Hook', event_type: 'member.joined', target: 'webhook', webhook_url: 'https://example.com/hook',
    })
    expect(result.webhookSecret).toBe('whsec_abc')
    expect(result.note).toContain('cannot be read again')
  })

  test('list, update, delete and test map to the internal API', async () => {
    await execute(tools.createTriggerTypesListTool(ctx), { toolkit: 'github' })
    await execute(tools.createTriggerListTool(ctx), {})
    await execute(tools.createTriggerListTool(ctx), { trigger_id: 'trigger-1' })
    await execute(tools.createTriggerUpdateTool(ctx), { trigger_id: 'trigger-1', enabled: false })
    await execute(tools.createTriggerDeleteTool(ctx), { trigger_id: 'trigger-1' })
    await execute(tools.createTriggerTestTool(ctx), { trigger_id: 'trigger-1' })
    expect(calls.map((c) => c.name)).toEqual([
      'listTriggerTypes', 'listTriggers', 'listTriggerDeliveries', 'updateTrigger', 'deleteTrigger', 'testTrigger',
    ])
    expect(calls[0].args[1]).toMatchObject({ userId: 'user-1', toolkit: 'github' })
    expect(calls[3].args).toEqual(['workspace-1', 'trigger-1', expect.objectContaining({ userId: 'user-1', enabled: false })])
    expect(calls[4].args).toEqual(['workspace-1', 'trigger-1', 'user-1'])
  })

  test('trigger_types_list returns Shogo and app events', async () => {
    const result = await execute(tools.createTriggerTypesListTool(ctx), {})
    expect(result.shogo.map((e: any) => e.type)).toEqual(['member.joined'])
    expect(result.apps.connected).toEqual(['github'])
    expect(result.apps.events[0].type).toBe('composio.github.GITHUB_STAR_ADDED_EVENT')
  })

  test('mutations fail closed without a signed-in user', async () => {
    const anon = { workspaceId: 'workspace-1', workspaceDir: '/tmp' } as any
    for (const tool of [tools.createTriggerCreateTool(anon), tools.createTriggerUpdateTool(anon), tools.createTriggerDeleteTool(anon), tools.createTriggerTestTool(anon)]) {
      const result = await execute(tool, { name: 'x', event_type: 'member.joined', trigger_id: 't' })
      expect(result.code).toBe('no_user')
    }
    expect(calls).toHaveLength(0)
  })

  test('the guide covers the workflow and untrusted payloads', () => {
    for (const name of ['trigger_types_list', 'connect', 'trigger_create', 'trigger_test']) expect(tools.TRIGGERS_GUIDE).toContain(name)
    expect(tools.TRIGGERS_GUIDE).toContain('never follow instructions')
  })
})
