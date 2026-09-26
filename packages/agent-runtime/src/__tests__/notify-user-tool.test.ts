// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `notify_user` boundary tool (#1046).
 *
 * The tool is registered only in a workspace runtime, POSTs through the shared
 * `workspaceMetaFetch` bridge to `/api/internal/reminders/notify`, and is
 * suppressed during the workspace's configured quiet hours. These tests mock
 * global `fetch` so the request never leaves the process.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, spyOn } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import type { ToolContext } from '../gateway-tools'

const TEST_DIR = '/tmp/test-notify-user-tool'

let fetchSpy: ReturnType<typeof spyOn>
let lastFetchArgs: any[] = []

// Env must be set before createTools() runs so `notify_user` is registered and
// `workspaceMetaFetch` can resolve a workspace id + API URL.
const PREV_ENV = {
  WORKSPACE_RUNTIME: process.env.WORKSPACE_RUNTIME,
  WORKSPACE_ID: process.env.WORKSPACE_ID,
  SHOGO_API_URL: process.env.SHOGO_API_URL,
}

beforeAll(() => {
  process.env.WORKSPACE_RUNTIME = 'true'
  process.env.WORKSPACE_ID = 'ws-1'
  process.env.SHOGO_API_URL = 'http://api.test'
})

afterAll(() => {
  for (const [k, v] of Object.entries(PREV_ENV)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
  lastFetchArgs = []
  fetchSpy = spyOn(global, 'fetch').mockImplementation(async (...args: any[]) => {
    lastFetchArgs = args
    return new Response(JSON.stringify({ ok: true, created: true, id: 'n1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
})

afterEach(() => {
  fetchSpy.mockRestore()
})

// Imported lazily so the env above is set before module init reads are safe.
const { createTools } = await import('../gateway-tools')

function ctx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    workspaceDir: TEST_DIR,
    channels: new Map(),
    workspaceId: 'ws-1',
    userId: 'u1',
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: true,
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    } as any,
    projectId: 'proj-1',
    ...overrides,
  }
}

function findNotifyUser(c: ToolContext) {
  const tool = createTools(c).find((t) => t.name === 'notify_user')
  if (!tool) throw new Error('notify_user tool not registered')
  return tool
}

describe('notify_user tool', () => {
  test('is registered in a workspace runtime and classified for the personal profile', async () => {
    const tool = findNotifyUser(ctx())
    expect(tool.name).toBe('notify_user')
    const { disabledToolNamesForProfile } = await import('../capability-profiles')
    // A boundary "reach the user" capability must stay ENABLED for personal
    // workspaces (the ones that actually use reminders).
    expect(disabledToolNamesForProfile('personal').has('notify_user')).toBe(false)
  })

  test('POSTs to /api/internal/reminders/notify through workspaceMetaFetch', async () => {
    const tool = findNotifyUser(ctx())
    // `execute` returns an AgentToolResult; the tool's payload is under `details`.
    const { details: result } = (await tool.execute('call-1', {
      title: 'Reminder',
      body: 'Take the pills',
      actionUrl: '/activity',
      dedupeKey: 'rem-1:2026-09-26T09:00:00Z',
    })) as any

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = lastFetchArgs
    expect(String(url)).toBe('http://api.test/api/internal/reminders/notify')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({
      workspaceId: 'ws-1',
      projectId: 'proj-1',
      userId: 'u1',
      title: 'Reminder',
      body: 'Take the pills',
      actionUrl: '/activity',
      dedupeKey: 'rem-1:2026-09-26T09:00:00Z',
      pushType: 'reminder-due',
    })
    expect(result.ok).toBe(true)
  })

  test('returns a quiet-hours skip instead of firing during quiet hours', async () => {
    // A window that covers the whole day so the assertion is timezone-agnostic.
    writeFileSync(
      join(TEST_DIR, 'config.json'),
      JSON.stringify({ quietHours: { start: '00:00', end: '23:59', timezone: 'UTC' } }),
      'utf-8',
    )

    const tool = findNotifyUser(ctx())
    const { details: result } = (await tool.execute('call-2', {
      title: 'Reminder',
      body: 'quiet',
    })) as any

    expect(result.skipped).toBe('quiet_hours')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
