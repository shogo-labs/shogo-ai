// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `heartbeat_configure` / `heartbeat_status`.
 *
 * The heartbeat schedule (enabled, interval, quiet hours, next/last run) lives
 * in the database. These tools talk to it through the project config API
 * (`configureProject` / `getProjectConfig`) and never read or write
 * config.json for schedule fields. The internal-api wrappers are faked so no
 * network call happens.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import * as realInternalApi from '../internal-api'

type Call = { fn: string; args: any[] }
const calls: Call[] = []

const agentRow = (over: Record<string, unknown> = {}) => ({
  heartbeatEnabled: false,
  heartbeatInterval: 1800,
  modelName: 'auto',
  modelProvider: 'anthropic',
  quietHoursStart: null,
  quietHoursEnd: null,
  quietHoursTimezone: null,
  nextHeartbeatAt: null,
  lastHeartbeatAt: null,
  ...over,
})

const api = {
  get: { ok: true, status: 200, data: { id: 'p-1', agent: agentRow() } } as any,
  configure: { ok: true, status: 200, data: { id: 'p-1', agent: agentRow() } } as any,
}

mock.module('../internal-api', () => ({
  ...realInternalApi,
  getProjectConfig: (projectId: string) => {
    calls.push({ fn: 'getProjectConfig', args: [projectId] })
    return api.get
  },
  configureProject: (projectId: string, patch: any) => {
    calls.push({ fn: 'configureProject', args: [projectId, patch] })
    return api.configure
  },
}))

const { createTools } = await import('../gateway-tools')
import type { ToolContext } from '../gateway-tools'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

const TEST_DIR = '/tmp/test-heartbeat-tools'
const PREV_ENV = {
  WORKSPACE_RUNTIME: process.env.WORKSPACE_RUNTIME,
  WORKSPACE_ANCHOR_PROJECT_ID: process.env.WORKSPACE_ANCHOR_PROJECT_ID,
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceDir: TEST_DIR,
    channels: new Map(),
    config: { channels: [], model: { provider: 'anthropic', name: 'claude-sonnet-4-5' } } as any,
    projectId: 'p-1',
    ...overrides,
  }
}

async function exec(ctx: ToolContext, name: string, params: Record<string, any> = {}) {
  const tool = createTools(ctx).find((t) => t.name === name)
  if (!tool) throw new Error(`Tool not found: ${name}`)
  const result = await tool.execute('call', params)
  return (result as any).details ?? result
}

beforeAll(() => trustWorkspaceForTests(TEST_DIR))
afterAll(() => {
  clearTrustForTests()
  for (const [k, v] of Object.entries(PREV_ENV)) {
    if (v === undefined) delete (process.env as any)[k]
    else (process.env as any)[k] = v
  }
})

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
  calls.length = 0
  delete process.env.WORKSPACE_RUNTIME
  delete process.env.WORKSPACE_ANCHOR_PROJECT_ID
  api.get = { ok: true, status: 200, data: { id: 'p-1', agent: agentRow() } }
  api.configure = {
    ok: true,
    status: 200,
    data: {
      id: 'p-1',
      agent: agentRow({
        heartbeatEnabled: true,
        heartbeatInterval: 600,
        quietHoursStart: '22:00',
        quietHoursEnd: '08:00',
        quietHoursTimezone: 'UTC',
        nextHeartbeatAt: '2026-10-08T10:10:00.000Z',
      }),
    },
  }
})

describe('heartbeat_configure', () => {
  test('rejects intervals below 60 seconds without calling the API', async () => {
    const d = await exec(makeCtx(), 'heartbeat_configure', { interval: 30 })
    expect(d.error).toContain('at least 60')
    expect(calls).toHaveLength(0)
  })

  test('writes the schedule to the database through configureProject (not config.json)', async () => {
    const d = await exec(makeCtx(), 'heartbeat_configure', {
      enabled: true, interval: 600, quietHoursStart: '22:00', quietHoursEnd: '08:00', timezone: 'UTC',
    })
    expect(calls).toEqual([
      {
        fn: 'configureProject',
        args: [
          'p-1',
          {
            agent: {
              heartbeatEnabled: true,
              heartbeatInterval: 600,
              quietHoursStart: '22:00',
              quietHoursEnd: '08:00',
              quietHoursTimezone: 'UTC',
            },
          },
        ],
      },
    ])
    expect(d.ok).toBe(true)
    expect(d.enabled).toBe(true)
    expect(d.interval).toBe(600)
    expect(d.quietHours).toEqual({ start: '22:00', end: '08:00', timezone: 'UTC' })
    expect(d.nextHeartbeatAt).toBe('2026-10-08T10:10:00.000Z')
    expect(existsSync(join(TEST_DIR, 'config.json'))).toBe(false)
  })

  test('leaves an existing config.json untouched', async () => {
    const original = JSON.stringify({ extra: 'kept', heartbeatToolsEnabled: true })
    writeFileSync(join(TEST_DIR, 'config.json'), original)
    await exec(makeCtx(), 'heartbeat_configure', { enabled: true })
    expect(readFileSync(join(TEST_DIR, 'config.json'), 'utf-8')).toBe(original)
  })

  test('only sends the fields that were given', async () => {
    await exec(makeCtx(), 'heartbeat_configure', { enabled: false })
    expect(calls[0].args[1]).toEqual({ agent: { heartbeatEnabled: false } })
  })

  test('with no changes it reads the current config instead of writing', async () => {
    await exec(makeCtx(), 'heartbeat_configure', {})
    expect(calls.map((c) => c.fn)).toEqual(['getProjectConfig'])
  })

  test('surfaces a paywall error and does not report success', async () => {
    api.configure = {
      ok: true,
      status: 200,
      data: {
        id: 'p-1',
        agent: agentRow(),
        heartbeatError: { code: 'paywall', message: 'Heartbeats require a paid plan.' },
      },
    }
    const d = await exec(makeCtx(), 'heartbeat_configure', { enabled: true })
    expect(d.ok).toBeUndefined()
    expect(d.code).toBe('paywall')
    expect(d.error).toContain('paid plan')
  })

  test('surfaces an API failure', async () => {
    api.configure = { ok: false, status: 500, error: 'boom', code: 'server_error' }
    const d = await exec(makeCtx(), 'heartbeat_configure', { enabled: true })
    expect(d.error).toContain('Failed to configure heartbeat')
    expect(d.error).toContain('boom')
  })

  test('targets an explicit projectId when given', async () => {
    await exec(makeCtx(), 'heartbeat_configure', { enabled: true, projectId: 'p-other' })
    expect(calls[0].args[0]).toBe('p-other')
  })

  test('a workspace runtime key (ws:<id>) is not a project: falls back to the anchor project', async () => {
    process.env.WORKSPACE_ANCHOR_PROJECT_ID = 'p-anchor'
    await exec(makeCtx({ projectId: 'ws:workspace-1' }), 'heartbeat_configure', { enabled: true })
    expect(calls[0].args[0]).toBe('p-anchor')
  })

  test('errors when there is no project to configure', async () => {
    const d = await exec(makeCtx({ projectId: 'ws:workspace-1' }), 'heartbeat_configure', { enabled: true })
    expect(d.error).toContain('No project')
    expect(calls).toHaveLength(0)
  })

  test('notifies the gateway so its cached status refreshes', async () => {
    let notified = 0
    await exec(makeCtx({ onHeartbeatConfigured: () => { notified++ } }), 'heartbeat_configure', { enabled: true })
    expect(notified).toBe(1)
  })
})

describe('heartbeat_status', () => {
  test('reports the database schedule including next and last run', async () => {
    api.get = {
      ok: true,
      status: 200,
      data: {
        id: 'p-1',
        agent: agentRow({
          heartbeatEnabled: true,
          heartbeatInterval: 900,
          quietHoursStart: '23:00',
          quietHoursEnd: '07:00',
          quietHoursTimezone: 'America/Los_Angeles',
          nextHeartbeatAt: '2026-10-08T10:00:00.000Z',
          lastHeartbeatAt: '2026-10-08T09:45:00.000Z',
        }),
      },
    }
    const d = await exec(makeCtx(), 'heartbeat_status')
    expect(d.projectId).toBe('p-1')
    expect(d.enabled).toBe(true)
    expect(d.interval).toBe(900)
    expect(d.quietHours).toEqual({ start: '23:00', end: '07:00', timezone: 'America/Los_Angeles' })
    expect(d.nextHeartbeatAt).toBe('2026-10-08T10:00:00.000Z')
    expect(d.lastHeartbeatAt).toBe('2026-10-08T09:45:00.000Z')
  })

  test('ignores schedule fields in config.json', async () => {
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({ heartbeatEnabled: true, heartbeatInterval: 5 }))
    const d = await exec(makeCtx(), 'heartbeat_status')
    expect(d.enabled).toBe(false)
    expect(d.interval).toBe(1800)
  })

  test('previews HEARTBEAT.md from the project directory', async () => {
    writeFileSync(join(TEST_DIR, 'HEARTBEAT.md'), '# Tasks\n- review\n- summarize')
    const d = await exec(makeCtx(), 'heartbeat_status')
    expect(d.checklistLength).toBeGreaterThan(0)
    expect(d.checklistPreview).toContain('Tasks')
  })

  test('in a workspace runtime, previews the target project\'s own HEARTBEAT.md, not the merged root\'s', async () => {
    process.env.WORKSPACE_RUNTIME = 'true'
    mkdirSync(join(TEST_DIR, 'p-1'), { recursive: true })
    mkdirSync(join(TEST_DIR, 'p-2'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'HEARTBEAT.md'), 'ROOT checklist')
    writeFileSync(join(TEST_DIR, 'p-1', 'HEARTBEAT.md'), 'P1 checklist')
    writeFileSync(join(TEST_DIR, 'p-2', 'HEARTBEAT.md'), 'P2 checklist')

    const own = await exec(makeCtx(), 'heartbeat_status')
    expect(own.checklistPreview).toBe('P1 checklist')

    const other = await exec(makeCtx(), 'heartbeat_status', { projectId: 'p-2' })
    expect(other.projectId).toBe('p-2')
    expect(other.checklistPreview).toBe('P2 checklist')
  })

  test('empty checklist when the project has no HEARTBEAT.md', async () => {
    const d = await exec(makeCtx(), 'heartbeat_status')
    expect(d.checklistLength).toBe(0)
  })

  test('surfaces an API failure', async () => {
    api.get = { ok: false, status: 404, error: 'not found' }
    const d = await exec(makeCtx(), 'heartbeat_status')
    expect(d.error).toContain('Failed to read heartbeat status')
  })
})
