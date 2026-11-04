// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `device: "<name>"` on the remote tool channel (SHO-285 Update 2): the cloud
 * Personal agent reaches the user's paired desktops through the same
 * allow-listed tools it already has, with a device as the target instead of a
 * project. No new tool, and no change when `device` is omitted.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { createTools, resetRemoteTargetCache, type ToolContext } from '../gateway-tools'
import { REMOTE_TOOL_ALLOWLIST } from '../remote-tools'
import { withIntegrationCredentials } from '../integration-credentials'

const WORKSPACE_ID = 'ws-device-test'
const PROJECT_ID = 'proj-device'
const DEVICES = [
  { id: 'inst-mac', name: "Russell's MacBook", os: 'darwin', online: true, lastSeenAt: '2026-11-04T00:00:00.000Z', homeDir: '/Users/russell' },
  { id: 'inst-win', name: 'Samsara', os: 'win32', online: false, lastSeenAt: '2026-11-03T20:00:00.000Z', homeDir: 'C:\\Users\\russell' },
]

const ENV_KEYS = ['PROJECT_ID', 'WORKSPACE_ID', 'SHOGO_API_URL', 'WORKSPACE_ANCHOR_PROJECT_ID', 'RUNTIME_AUTH_SECRET']
let saved: Record<string, string | undefined> = {}
let originalFetch: typeof fetch
let dir = ''

function toolCtx(workspaceDir: string): ToolContext {
  return { workspaceDir, channels: new Map(), config: {} as any, projectId: PROJECT_ID, workspaceId: WORKSPACE_ID }
}

function toolNamed(tools: AgentTool[], name: string): AgentTool {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`tool ${name} not registered`)
  return tool
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  originalFetch = globalThis.fetch
  process.env.PROJECT_ID = PROJECT_ID
  process.env.WORKSPACE_ID = WORKSPACE_ID
  process.env.SHOGO_API_URL = 'http://api.test'
  delete process.env.WORKSPACE_ANCHOR_PROJECT_ID
  resetRemoteTargetCache()
  dir = mkdtempSync(join('/tmp', 'shogo-remote-device-'))
})

afterEach(() => {
  globalThis.fetch = originalFetch
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetRemoteTargetCache()
  rmSync(dir, { recursive: true, force: true })
})

describe('device target on the remote tool channel', () => {
  test('every remotable tool gains an optional device param; others do not', () => {
    const tools = createTools(toolCtx(dir))
    for (const name of REMOTE_TOOL_ALLOWLIST) {
      const tool = tools.find((t) => t.name === name)
      if (!tool) continue // search is registered only with SHOGO_SEARCH_ENABLED
      const schema = tool.parameters as any
      expect(schema.properties.device?.type).toBe('string')
      expect(schema.required ?? []).not.toContain('device')
    }
    const exec = toolNamed(tools, 'exec').parameters as any
    expect(exec.required).toContain('command')
    expect((toolNamed(tools, 'project_call').parameters as any).properties.device).toBeUndefined()
  })

  test('device omitted runs here and never calls the API', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return Response.json({ ok: false, error: 'should not be called' }, { status: 500 })
    }) as typeof fetch

    const write = toolNamed(createTools(toolCtx(dir)), 'write_file')
    await write.execute('w1', { path: 'local.txt', content: 'here' })
    expect(readFileSync(join(dir, 'local.txt'), 'utf-8')).toBe('here')
    expect(calls).toEqual([])
  })

  test('a device name runs the tool on that desktop, without the device arg', async () => {
    const seen: Array<{ url: string; body: any }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/internal/devices')) return Response.json({ devices: DEVICES })
      if (url.includes('/api/internal/devices/')) {
        seen.push({ url, body: JSON.parse(String(init?.body ?? '{}')) })
        return Response.json({
          ok: true,
          result: { content: [{ type: 'text', text: 'canary' }], details: { path: '/Users/russell/canary.txt' } },
        })
      }
      return Response.json({ ok: false, error: 'unexpected call' }, { status: 500 })
    }) as typeof fetch

    const read = toolNamed(createTools(toolCtx(dir)), 'read_file')
    const result = await read.execute('r1', { path: '/Users/russell/canary.txt', device: "Russell's MacBook" })

    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe('http://api.test/api/internal/devices/inst-mac/remote-tool')
    expect(seen[0]!.body).toEqual({ tool: 'read_file', args: { path: '/Users/russell/canary.txt' } })
    expect(JSON.stringify(result.content)).toContain('canary')
  })

  test('the call carries the turn’s requester ticket, so the API can check who is asking', async () => {
    const headers: Headers[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/internal/devices')) return Response.json({ devices: DEVICES })
      headers.push(new Headers(init?.headers))
      return Response.json({ ok: true, result: { content: [{ type: 'text', text: 'ok' }] } })
    }) as typeof fetch

    const read = toolNamed(createTools(toolCtx(dir)), 'read_file')
    // The gateway runs every tool inside this wrapper (SHO-285 Update 2), which
    // is what puts the ticket on the internal API call.
    const scoped = withIntegrationCredentials(read, {
      projectId: PROJECT_ID,
      requesterTicket: 'signed-ticket-for-russell',
    } as any)
    await scoped.execute('r1', { path: 'canary.txt', device: 'inst-mac' })

    expect(headers).toHaveLength(1)
    expect(headers[0]!.get('X-Requester-Ticket')).toBe('signed-ticket-for-russell')
  })

  test('an instance id works too, and a partial name matches', async () => {
    const urls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/internal/devices')) return Response.json({ devices: DEVICES })
      urls.push(url)
      return Response.json({ ok: true, result: { content: [{ type: 'text', text: 'ok' }] } })
    }) as typeof fetch

    const read = toolNamed(createTools(toolCtx(dir)), 'read_file')
    await read.execute('r1', { path: 'a.txt', device: 'inst-win' })
    await read.execute('r2', { path: 'a.txt', device: 'samsara' })
    expect(urls).toEqual([
      'http://api.test/api/internal/devices/inst-win/remote-tool',
      'http://api.test/api/internal/devices/inst-win/remote-tool',
    ])
  })

  test('an unknown device names the ones that exist', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/internal/devices')) return Response.json({ devices: DEVICES })
      return Response.json({ ok: false, error: 'unexpected call' }, { status: 500 })
    }) as typeof fetch

    const read = toolNamed(createTools(toolCtx(dir)), 'read_file')
    const result = await read.execute('r1', { path: 'a.txt', device: 'Nope' })
    const details = result.details as any
    expect(details.code).toBe('device_not_found')
    expect(details.error).toContain("Russell's MacBook")
    expect(details.error).toContain('Samsara')
  })

  test('an offline device surfaces device_offline with its last-seen time', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/internal/devices')) return Response.json({ devices: DEVICES })
      return Response.json(
        {
          error: {
            code: 'device_offline',
            message: 'Samsara is offline (last seen 2026-11-03T20:00:00.000Z)',
            instanceId: 'inst-win',
            lastSeenAt: '2026-11-03T20:00:00.000Z',
          },
        },
        { status: 503 },
      )
    }) as typeof fetch

    const read = toolNamed(createTools(toolCtx(dir)), 'read_file')
    const result = await read.execute('r1', { path: 'a.txt', device: 'Samsara' })
    const details = result.details as any
    expect(details.code).toBe('device_offline')
    expect(details.device).toBe('Samsara')
    expect(details.error).toContain('last seen 2026-11-03T20:00:00.000Z')
  })

  test('an empty device string is refused before any call', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return Response.json({ devices: DEVICES })
    }) as typeof fetch

    const read = toolNamed(createTools(toolCtx(dir)), 'read_file')
    const result = await read.execute('r1', { path: 'a.txt', device: '   ' })
    expect((result.details as any).error).toContain('device')
    expect(calls).toEqual([])
  })
})
