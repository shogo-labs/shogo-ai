// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * WS4: the `checkpoint` agent tool talks to the cluster-internal checkpoint
 * routes so the agent can list / diff / roll back the existing auto-checkpoint
 * system (fixing the "no git history" lie). These tests mock `fetch` to assert
 * the tool hits the right endpoints and surfaces external-mode gracefully.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createTools, type ToolContext } from '../gateway-tools'
import { FileStateCache } from '../file-state-cache'

const PROJECT_ID = 'proj_abc'

function makeCtx(): ToolContext {
  return {
    workspaceDir: '/tmp/test-checkpoint-tool',
    channels: new Map(),
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    } as any,
    projectId: PROJECT_ID,
    fileStateCache: new FileStateCache(),
  }
}

function getCheckpointTool(ctx: ToolContext) {
  const tool = createTools(ctx).find(t => t.name === 'checkpoint')
  if (!tool) throw new Error('checkpoint tool not registered')
  return tool
}

const realFetch = globalThis.fetch
let lastUrl = ''
let lastInit: RequestInit | undefined

function mockFetch(status: number, body: unknown) {
  lastUrl = ''
  lastInit = undefined
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    lastUrl = String(url)
    lastInit = init
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as any
  }) as any
}

beforeEach(() => {
  process.env.SHOGO_API_URL = 'http://test-api'
})
afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.SHOGO_API_URL
})

describe('checkpoint tool', () => {
  test('list hits the internal list endpoint and returns checkpoints', async () => {
    mockFetch(200, {
      ok: true,
      checkpoints: [
        { id: 'cp_2', name: 'Add toggle', createdAt: '2026-06-20T10:00:00Z', isAutomatic: true },
        { id: 'cp_1', message: 'Initial', createdAt: '2026-06-20T09:00:00Z', isAutomatic: true },
      ],
    })
    const tool = getCheckpointTool(makeCtx())
    const res = await tool.execute('id', { action: 'list' })
    expect(lastUrl).toContain(`/api/internal/projects/${PROJECT_ID}/checkpoints`)
    expect(res.details.count).toBe(2)
    expect(res.details.checkpoints[0].id).toBe('cp_2')
    expect(res.details.checkpoints[0].message).toBe('Add toggle')
  })

  test('rollback POSTs to the rollback endpoint', async () => {
    mockFetch(200, { ok: true, rolledBackTo: { id: 'cp_1' } })
    const tool = getCheckpointTool(makeCtx())
    const res = await tool.execute('id', { action: 'rollback', checkpoint_id: 'cp_1' })
    expect(lastUrl).toContain(`/checkpoints/cp_1/rollback`)
    expect(lastInit?.method).toBe('POST')
    expect(res.details.ok).toBe(true)
    expect(res.details.rolledBack).toBe(true)
  })

  test('rollback without checkpoint_id errors before calling the API', async () => {
    mockFetch(200, {})
    const tool = getCheckpointTool(makeCtx())
    const res = await tool.execute('id', { action: 'rollback' })
    expect(res.details.error).toContain('checkpoint_id is required')
    expect(lastUrl).toBe('')
  })

  test('external-mode 409 is surfaced gracefully (not a hard failure)', async () => {
    mockFetch(409, {
      error: {
        code: 'checkpoints_disabled_in_external_mode',
        message: 'Checkpoints are disabled for folder-linked projects.',
      },
    })
    const tool = getCheckpointTool(makeCtx())
    const res = await tool.execute('id', { action: 'list' })
    expect(res.details.external_mode).toBe(true)
    expect(res.details.hint).toContain('own git')
  })
})
